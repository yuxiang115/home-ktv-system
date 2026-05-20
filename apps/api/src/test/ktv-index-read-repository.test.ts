import { describe, expect, it } from "vitest";
import type { QueryExecutor } from "../db/query-executor.js";
import { buildNasSample } from "../modules/ktv-index/ktv-index-diagnostics.js";
import { PgKtvIndexReadRepository } from "../modules/ktv-index/ktv-index-read-repository.js";

describe("PgKtvIndexReadRepository", () => {
  it("searches active indexed songs with grouped nonqueueable versions", async () => {
    const db = new ScriptedKtvIndexDb();
    const repository = new PgKtvIndexReadRepository(db);

    const results = await repository.searchIndexedSongs({
      query: "七里香",
      limit: 10,
      versionsPerSong: 2
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      indexedSongId: "ktv-song-1",
      title: "七里香",
      artistName: "周杰伦",
      category: "流行",
      sourceLabel: "KTV索引",
      matchReason: "title"
    });
    expect(results[0]?.versions).toEqual([
      {
        indexedAssetId: "ktv-asset-1",
        displayName: "周杰伦-七里香-国语-流行.mkv",
        sourceLabel: "KTV索引",
        extension: ".mkv",
        sizeBytes: 123456,
        category: "流行",
        queueState: "needs_catalog_sync",
        canQueue: false,
        disabledLabel: "需同步入库后可点歌"
      },
      {
        indexedAssetId: "ktv-asset-2",
        displayName: "周杰伦-七里香-国语-演唱会.mpg",
        sourceLabel: "KTV索引",
        extension: ".mpg",
        sizeBytes: null,
        category: "演唱会",
        queueState: "needs_catalog_sync",
        canQueue: false,
        disabledLabel: "需同步入库后可点歌"
      }
    ]);
    expect(JSON.stringify(results)).not.toContain("filePath");
    expect(JSON.stringify(results)).not.toContain("/mnt/nas");

    const searchQuery = db.queries.find((query) => query.text.includes("similarity(s.normalized_title"));
    expect(searchQuery?.text).toContain("a.missing_at IS NULL");
    expect(searchQuery?.text).toContain("ktv_song_artists");
    expect(searchQuery?.text).toContain("ktv_artists");
    expect(searchQuery?.values).toEqual(["七里香", "%七里香%", "%七里香%", 10, 2]);
  });

  it("returns raw diagnostics and Admin-only preview details", async () => {
    const db = new ScriptedKtvIndexDb();
    const repository = new PgKtvIndexReadRepository(db);

    const diagnostics = await repository.getDiagnostics({
      previewQuery: "七里香",
      previewLimit: 8,
      deterministicSample: true
    });

    expect(diagnostics).toMatchObject({
      sourceRoot: "/mnt/nas/KTV歌曲",
      activeAssetCount: 34385,
      missingAssetCount: 28,
      songCount: 31893,
      artistCount: 8568,
      lowConfidenceCount: 0,
      minParseConfidence: 0.98,
      nasSample: {
        requested: 0,
        checked: 0,
        readable: 0,
        missing: 0,
        unreadable: 0,
        timeout: 0,
        unmapped: 0,
        results: []
      }
    });
    expect(diagnostics.tables.every((table) => table.exists)).toBe(true);
    expect(diagnostics.latestRun).toMatchObject({
      id: "run-1",
      sourceRoot: "/mnt/nas/KTV歌曲",
      status: "completed",
      filesSeen: 34385
    });
    expect(diagnostics.parseStrategies).toEqual([{ parseStrategy: "filename", count: 34385 }]);
    expect(diagnostics.preview[0]?.versions[0]).toMatchObject({
      indexedAssetId: "ktv-asset-1",
      filePath: "/mnt/nas/KTV歌曲/周杰伦-七里香-国语-流行.mkv",
      parseConfidence: 0.98,
      missingAt: null
    });

    expect(db.queries.map((query) => query.text)).toEqual(expect.arrayContaining([
      expect.stringContaining("to_regclass"),
      expect.stringContaining("count(*) FILTER (WHERE a.missing_at IS NULL)"),
      expect.stringContaining("parse_confidence < 0.75")
    ]));
  });
});

describe("buildNasSample", () => {
  it("classifies unmapped paths before touching the filesystem", async () => {
    const accessed: string[] = [];
    const nasSample = await buildNasSample({
      sourceRoot: "/mnt/nas/KTV歌曲",
      assets: [
        { indexedAssetId: "blank", filePath: "" },
        { indexedAssetId: "relative", filePath: "relative/song.mkv" },
        { indexedAssetId: "outside", filePath: "/other/root/song.mkv" }
      ],
      accessFile: async (filePath) => {
        accessed.push(filePath);
      }
    });

    expect(accessed).toEqual([]);
    expect(nasSample.unmapped).toBe(3);
    expect(nasSample.missing).toBe(0);
    expect(nasSample.unreadable).toBe(0);
    expect(nasSample.timeout).toBe(0);
    expect(nasSample.results.map((result) => result.status)).toEqual(["unmapped", "unmapped", "unmapped"]);
    expect(nasSample.results[0]).toMatchObject({ filePath: "", status: "unmapped", message: "path is blank" });
    expect(nasSample.results[1]).toMatchObject({
      filePath: "relative/song.mkv",
      status: "unmapped",
      message: "path is not absolute"
    });
    expect(nasSample.results[2]).toMatchObject({
      filePath: "/other/root/song.mkv",
      status: "unmapped",
      message: "path outside source root"
    });
  });

  it("keeps missing unreadable and timeout counts separate from unmapped", async () => {
    const nasSample = await buildNasSample({
      sourceRoot: "/mnt/nas/KTV歌曲",
      timeoutMs: 50,
      assets: [
        { indexedAssetId: "missing", filePath: "/mnt/nas/KTV歌曲/missing.mkv" },
        { indexedAssetId: "unreadable", filePath: "/mnt/nas/KTV歌曲/unreadable.mkv" },
        { indexedAssetId: "timeout", filePath: "/mnt/nas/KTV歌曲/timeout.mkv" }
      ],
      accessFile: async (filePath) => {
        if (filePath.includes("missing")) {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        }
        if (filePath.includes("unreadable")) {
          throw new Error("permission denied");
        }
        await new Promise(() => {});
      }
    });

    expect(nasSample.unmapped).toBe(0);
    expect(nasSample.missing).toBe(1);
    expect(nasSample.unreadable).toBe(1);
    expect(nasSample.timeout).toBe(1);
    expect(nasSample.results.map((result) => result.status)).toEqual(["missing", "unreadable", "timeout"]);
  });
});

interface RecordedQuery {
  text: string;
  values: readonly unknown[];
}

class ScriptedKtvIndexDb implements QueryExecutor {
  readonly queries: RecordedQuery[] = [];

  async query<TRow>(text: string, values: readonly unknown[] = []) {
    this.queries.push({ text, values });

    if (text.includes("to_regclass")) {
      return {
        rows: [
          { table_name: "ktv_index_runs", exists: true },
          { table_name: "ktv_artists", exists: true },
          { table_name: "ktv_songs", exists: true },
          { table_name: "ktv_song_artists", exists: true },
          { table_name: "ktv_song_assets", exists: true }
        ] as TRow[]
      };
    }

    if (text.includes("FROM ktv_index_runs")) {
      return {
        rows: [
          {
            id: "run-1",
            source_root: "/mnt/nas/KTV歌曲",
            ssh_host: "lxc-nas",
            status: "completed",
            files_seen: 34385,
            songs_upserted: 31893,
            assets_upserted: 34385,
            error_message: null,
            started_at: new Date("2026-05-20T01:00:00.000Z"),
            finished_at: new Date("2026-05-20T01:10:00.000Z")
          }
        ] as TRow[]
      };
    }

    if (text.includes("count(*) FILTER (WHERE a.missing_at IS NULL)")) {
      return {
        rows: [
          {
            active_asset_count: "34385",
            missing_asset_count: "28",
            song_count: "31893",
            artist_count: "8568"
          }
        ] as TRow[]
      };
    }

    if (text.includes("GROUP BY parse_strategy")) {
      return { rows: [{ parse_strategy: "filename", count: "34385" }] as TRow[] };
    }

    if (text.includes("parse_confidence < 0.75")) {
      return { rows: [{ low_confidence_count: "0", min_parse_confidence: "0.980" }] as TRow[] };
    }

    if (text.includes("ORDER BY updated_at DESC") || text.includes("ORDER BY random()")) {
      return { rows: [] as TRow[] };
    }

    if (text.includes("WITH matched_songs")) {
      return {
        rows: [
          createSearchRow({
            asset_id: "ktv-asset-1",
            file_name: "周杰伦-七里香-国语-流行.mkv",
            file_path: "/mnt/nas/KTV歌曲/周杰伦-七里香-国语-流行.mkv",
            extension: ".mkv",
            size_bytes: "123456",
            category: "流行"
          }),
          createSearchRow({
            asset_id: "ktv-asset-2",
            file_name: "周杰伦-七里香-国语-演唱会.mpg",
            file_path: "/mnt/nas/KTV歌曲/周杰伦-七里香-国语-演唱会.mpg",
            extension: ".mpg",
            size_bytes: null,
            category: "演唱会"
          })
        ] as TRow[]
      };
    }

    return { rows: [] as TRow[] };
  }
}

function createSearchRow(overrides: Record<string, unknown> = {}) {
  return {
    song_id: "ktv-song-1",
    title: "七里香",
    primary_artist_name: "周杰伦",
    category: "流行",
    match_reason: "title",
    score: 100,
    asset_id: "ktv-asset-1",
    file_name: "周杰伦-七里香-国语-流行.mkv",
    file_path: "/mnt/nas/KTV歌曲/周杰伦-七里香-国语-流行.mkv",
    extension: ".mkv",
    size_bytes: "123456",
    parse_confidence: "0.980",
    missing_at: null,
    ...overrides
  };
}
