import { describe, expect, it } from "vitest";
import type { QueryExecutor } from "../db/query-executor.js";
import { buildNasSample } from "../modules/ktv-index/ktv-index-diagnostics.js";
import { PgKtvIndexReadRepository } from "../modules/ktv-index/ktv-index-read-repository.js";

describe("PgKtvIndexReadRepository", () => {
  it("searches active indexed songs as playable NAS rows", async () => {
    const db = new ScriptedKtvIndexDb();
    const repository = new PgKtvIndexReadRepository(db);

    const results = await repository.searchIndexedSongs({
      query: "七里香",
      limit: 10,
      versionsPerSong: 2
    });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      indexedSongId: "ktv-asset-1",
      title: "七里香",
      artistName: "周杰伦",
      styleTags: ["流行", "KTV必点"],
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
        audioTrackCount: 1,
        styleTags: ["流行", "KTV必点"],
        category: "流行",
        queueState: "not_queued",
        canQueue: true,
        disabledLabel: null
      }
    ]);
    expect(JSON.stringify(results)).not.toContain("filePath");
    expect(JSON.stringify(results)).not.toContain("/mnt/nas");

    const searchQuery = db.queries.find((query) => query.text.includes("similarity(s.normalized_title"));
    expect(searchQuery?.text).toContain("s.missing_at IS NULL");
    expect(searchQuery?.text).not.toContain("ktv_song_artists");
    expect(searchQuery?.text).not.toContain("ktv_artists");
    expect(searchQuery?.text).not.toContain("s.category");
    expect(searchQuery?.text).not.toContain("ktv_song_style_tags");
    expect(searchQuery?.text).toContain("unnest(s.style_tags)");
    expect(searchQuery?.text).toContain("s.id AS asset_id");
    expect(searchQuery?.text).not.toContain("JOIN ktv_style_tags");
    expect(searchQuery?.text).not.toContain("JOIN ktv_style_groups");
    expect(searchQuery?.text).not.toContain("st.tag_id");
    expect(searchQuery?.values).toEqual(["七里香", "%七里香%", "%七里香%", 10]);
  });

  it("maps queued and unreadable indexed assets to explicit queue states", async () => {
    const db = new ScriptedKtvIndexDb();
    const repository = new PgKtvIndexReadRepository(db);

    const results = await repository.searchIndexedSongs({
      query: "七里香",
      limit: 10,
      versionsPerSong: 2,
      queuedIndexedAssetIds: ["ktv-asset-1"],
      unreadableIndexedAssetIds: ["ktv-asset-2"]
    });

    expect(results[0]?.versions).toEqual([
      expect.objectContaining({
        indexedAssetId: "ktv-asset-1",
        queueState: "queued",
        canQueue: true,
        disabledLabel: null
      })
    ]);
    expect(results[1]?.versions).toEqual([
      expect.objectContaining({
        indexedAssetId: "ktv-asset-2",
        queueState: "file_unreadable",
        canQueue: false,
        disabledLabel: "文件不可读"
      })
    ]);
  });

  it("lists discovery artist and genre summaries from the full active catalog", async () => {
    const db = new ScriptedKtvIndexDb();
    const repository = new PgKtvIndexReadRepository(db);

    const artists = await (repository as unknown as {
      listDiscoveryArtists(): Promise<Array<{ artistId: string; artistName: string; songCount: number; playCount: number }>>;
    }).listDiscoveryArtists();
    const genres = await (repository as unknown as {
      listDiscoveryGenres(): Promise<Array<{ genre: string; songCount: number; playCount: number }>>;
    }).listDiscoveryGenres();

    expect(artists).toEqual([
      { artistId: "周杰伦", artistName: "周杰伦", songCount: 120, playCount: 300 },
      { artistId: "五月天", artistName: "五月天", songCount: 80, playCount: 40 }
    ]);
    expect(genres).toEqual([
      { genre: "流行", songCount: 600, playCount: 1200 },
      { genre: "未打标签", songCount: 12, playCount: 0 }
    ]);

    const artistQuery = db.queries.find((query) => query.text.includes("WITH song_artists AS"));
    expect(artistQuery?.text).toContain("unnest(");
    expect(artistQuery?.text).toContain("s.missing_at IS NULL");
    expect(artistQuery?.text).toMatch(/ORDER BY song_count DESC,\s*play_count DESC,\s*artist_name ASC/u);
    const genreQuery = db.queries.find((query) => query.text.includes("genre_catalog"));
    expect(genreQuery?.text).toContain("unnest(active_songs.style_tags)");
    expect(genreQuery?.text).toMatch(/ORDER BY song_count DESC,\s*play_count DESC,\s*genre ASC/u);
    expect(genreQuery?.values).toEqual(["未打标签"]);
  });

  it("loads paged indexed songs by artist or genre", async () => {
    const db = new ScriptedKtvIndexDb();
    const repository = new PgKtvIndexReadRepository(db);

    const artistSongs = await (repository as unknown as {
      listIndexedSongsByArtist(input: {
        artistId: string;
        limit: number;
        offset: number;
        queuedIndexedAssetIds: string[];
        unreadableIndexedAssetIds: string[];
      }): Promise<unknown[]>;
    }).listIndexedSongsByArtist({
      artistId: "周杰伦",
      limit: 20,
      offset: 40,
      queuedIndexedAssetIds: ["ktv-asset-1"],
      unreadableIndexedAssetIds: []
    });
    const genreSongs = await (repository as unknown as {
      listIndexedSongsByGenre(input: {
        genre: string;
        limit: number;
        offset: number;
        queuedIndexedAssetIds: string[];
        unreadableIndexedAssetIds: string[];
      }): Promise<unknown[]>;
    }).listIndexedSongsByGenre({
      genre: "流行",
      limit: 20,
      offset: 0,
      queuedIndexedAssetIds: [],
      unreadableIndexedAssetIds: ["ktv-asset-2"]
    });

    expect(artistSongs).toHaveLength(1);
    expect(genreSongs).toHaveLength(1);
    expect(artistSongs[0]).toMatchObject({
      indexedSongId: "ktv-asset-1",
      versions: [expect.objectContaining({ indexedAssetId: "ktv-asset-1", queueState: "queued" })]
    });
    expect(genreSongs[0]).toMatchObject({
      indexedSongId: "ktv-asset-1",
      versions: [expect.objectContaining({ indexedAssetId: "ktv-asset-1" })]
    });

    expect(db.queries.find((query) => query.text.includes("$1 = ANY("))?.values).toEqual([
      "周杰伦",
      20,
      40
    ]);
    expect(db.queries.find((query) => query.text.includes("$1 = ANY(s.style_tags)"))?.values).toEqual(["流行", 20, 0]);
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
      technicalStatusCounts: [
        { technicalStatus: "failed", count: 2 },
        { technicalStatus: "pending", count: 100 },
        { technicalStatus: "probed", count: 280 }
      ],
      audioTrackDistribution: [
        { audioTrackCount: 1, count: 12 },
        { audioTrackCount: 2, count: 260 },
        { audioTrackCount: 3, count: 8 }
      ],
      probePendingCount: 100,
      probeFailedCount: 2,
      probeCoveragePercent: 0.81,
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
      expect.stringContaining("count(*) FILTER (WHERE s.missing_at IS NULL)"),
      expect.stringContaining("GROUP BY technical_status"),
      expect.stringContaining("jsonb_array_length"),
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
        rows: [{ table_name: "ktv_songs", exists: true }] as TRow[]
      };
    }

    if (text.includes("WITH latest_run")) {
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

    if (text.includes("count(*) FILTER (WHERE s.missing_at IS NULL)")) {
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

    if (text.includes("GROUP BY technical_status")) {
      return {
        rows: [
          { technical_status: "failed", count: "2" },
          { technical_status: "pending", count: "100" },
          { technical_status: "probed", count: "280" }
        ] as TRow[]
      };
    }

    if (text.includes("jsonb_array_length")) {
      return {
        rows: [
          { audio_track_count: "1", count: "12" },
          { audio_track_count: "2", count: "260" },
          { audio_track_count: "3", count: "8" }
        ] as TRow[]
      };
    }

    if (text.includes("parse_confidence < 0.75")) {
      return { rows: [{ low_confidence_count: "0", min_parse_confidence: "0.980" }] as TRow[] };
    }

    if (text.includes("ORDER BY updated_at DESC") || text.includes("ORDER BY random()")) {
      return { rows: [] as TRow[] };
    }

    if (text.includes("WITH song_artists AS")) {
      return {
        rows: [
          { artist_id: "周杰伦", artist_name: "周杰伦", song_count: "120", play_count: "300" },
          { artist_id: "五月天", artist_name: "五月天", song_count: "80", play_count: "40" }
        ] as TRow[]
      };
    }

    if (text.includes("genre_catalog")) {
      return {
        rows: [
          { genre: "流行", song_count: "600", play_count: "1200" },
          { genre: "未打标签", song_count: "12", play_count: "0" }
        ] as TRow[]
      };
    }

    if (text.includes("$1 = ANY(") || text.includes("$1 = ANY(s.style_tags)")) {
      return { rows: [createSearchRow()] as TRow[] };
    }

    if (text.includes("similarity(s.normalized_title")) {
      return {
        rows: [
          createSearchRow({
            song_id: "ktv-asset-1",
            asset_id: "ktv-asset-1",
            file_name: "周杰伦-七里香-国语-流行.mkv",
            file_path: "/mnt/nas/KTV歌曲/周杰伦-七里香-国语-流行.mkv",
            extension: ".mkv",
            size_bytes: "123456",
            technical_metadata: {
              mediaInfoSummary: {
                audioTracks: [
                  { index: 0, id: "0", label: "Audio 1", language: null, codec: "mp2", channels: 2 }
                ]
              }
            },
            style_tags: ["流行", "KTV必点"]
          }),
          createSearchRow({
            song_id: "ktv-asset-2",
            asset_id: "ktv-asset-2",
            file_name: "周杰伦-七里香-国语-演唱会.mpg",
            file_path: "/mnt/nas/KTV歌曲/周杰伦-七里香-国语-演唱会.mpg",
            extension: ".mpg",
            size_bytes: null,
            technical_metadata: {
              audioTracks: [
                { index: 0, id: "0", label: "原唱", language: null, codec: "mp2", channels: 2 },
                { index: 1, id: "1", label: "伴奏", language: null, codec: "mp2", channels: 2 }
              ]
            },
            style_tags: ["流行", "KTV必点"]
          })
        ] as TRow[]
      };
    }

    return { rows: [] as TRow[] };
  }
}

function createSearchRow(overrides: Record<string, unknown> = {}) {
  return {
    song_id: "ktv-asset-1",
    title: "七里香",
    primary_artist_name: "周杰伦",
    style_tags: ["流行", "KTV必点"],
    match_reason: "title",
    score: 100,
    asset_id: "ktv-asset-1",
    file_name: "周杰伦-七里香-国语-流行.mkv",
    file_path: "/mnt/nas/KTV歌曲/周杰伦-七里香-国语-流行.mkv",
    extension: ".mkv",
    size_bytes: "123456",
    parse_confidence: "0.980",
    technical_metadata: {},
    missing_at: null,
    ...overrides
  };
}
