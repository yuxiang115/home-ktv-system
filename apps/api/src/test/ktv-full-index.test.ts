import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { schemaSql, tableNames } from "../db/schema.js";
import type { QueryExecutor } from "../db/query-executor.js";
import {
  buildKtvIndexAssetDraft,
  indexKtvAssetDrafts,
  type KtvIndexAssetDraft
} from "../modules/ingest/ktv-full-index.js";

const migrationUrl = new URL("../db/migrations/0008_ktv_full_index.sql", import.meta.url);
const migrationSql = existsSync(migrationUrl) ? readFileSync(migrationUrl, "utf8") : "";
const activeAssetIndexMigrationUrl = new URL("../db/migrations/0009_ktv_active_asset_indexes.sql", import.meta.url);
const activeAssetIndexMigrationSql = existsSync(activeAssetIndexMigrationUrl)
  ? readFileSync(activeAssetIndexMigrationUrl, "utf8")
  : "";

describe("KTV full index schema", () => {
  it("keeps a single playable-file ktv_songs table in the final schema", () => {
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS ktv_song_assets");
    expect(schemaSql).toContain("CREATE TABLE IF NOT EXISTS ktv_songs");
    for (const removedTable of [
      "CREATE TABLE IF NOT EXISTS ktv_index_runs",
      "CREATE TABLE IF NOT EXISTS ktv_artists",
      "CREATE TABLE IF NOT EXISTS ktv_song_artists",
      "CREATE TABLE IF NOT EXISTS ktv_song_assets"
    ]) {
      expect(schemaSql).not.toContain(removedTable);
    }

    expect(tableNames.ktvSongs).toBe("ktv_songs");
    expect(Object.values(tableNames)).not.toContain("ktv_song_assets");
  });

  it("indexes title, artist, and path lookup columns without retaining legacy category", () => {
    for (const expected of [
      "ktv_songs_normalized_title_trgm_idx",
      "ktv_songs_artist_names_gin_idx",
      "ktv_songs_file_path_uq"
    ]) {
      expect(schemaSql).toContain(expected);
    }
    expect(schemaSql).not.toContain("category text NOT NULL");
    expect(schemaSql).not.toContain("ktv_songs_category_idx");
  });

  it("adds partial indexes for active playable songs", () => {
    for (const expected of [
      "ktv_songs_active_idx",
      "WHERE missing_at IS NULL"
    ]) {
      expect(schemaSql).toContain(expected);
    }
    expect(activeAssetIndexMigrationSql).toContain("ktv_song_assets_active_song_idx");
  });
});

describe("KTV full index importer", () => {
  it("builds a full index asset draft from a source file", () => {
    const draft = buildKtvIndexAssetDraft({
      sourcePath: "/mnt/nas/KTV歌曲/流行歌曲(2.5万首880G)/推荐0001/谢金燕-练舞功(MTV)-闽南语-流行.mkv",
      relativePath: "流行歌曲(2.5万首880G)/推荐0001/谢金燕-练舞功(MTV)-闽南语-流行.mkv",
      sizeBytes: 123,
      mtimeMs: 456
    });

    expect(draft).toMatchObject({
      title: "练舞功",
      artistNames: ["谢金燕"],
      filePath: "/mnt/nas/KTV歌曲/流行歌曲(2.5万首880G)/推荐0001/谢金燕-练舞功(MTV)-闽南语-流行.mkv",
      relativePath: "流行歌曲(2.5万首880G)/推荐0001/谢金燕-练舞功(MTV)-闽南语-流行.mkv",
      technicalStatus: "pending"
    });
  });

  it("does not treat variety show names as artists when splitting filename artist text", () => {
    const cases = [
      {
        relativePath: "流行歌曲(2.5万首880G)/推荐0038/张杰_吴汶芳_最美和声-夜夜夜夜(演唱会)-国语-流行.mkv",
        expectedArtists: ["张杰", "吴汶芳"]
      },
      {
        relativePath: "流行歌曲(2.5万首880G)/推荐0062/姚贝娜_中国好声音-DEAR FRIEND(演唱会)-国语-流行.mkv",
        expectedArtists: ["姚贝娜"]
      },
      {
        relativePath: "综合专辑 9300首1.4T/综艺专区2（1000首）/我是歌手/张宇_我是歌手-20岁的眼泪(演唱会)-国语-流行.mpg",
        expectedArtists: ["张宇"]
      }
    ] as const;

    for (const testCase of cases) {
      const draft = buildKtvIndexAssetDraft({
        sourcePath: `/mnt/nas/KTV歌曲/${testCase.relativePath}`,
        relativePath: testCase.relativePath,
        sizeBytes: 123,
        mtimeMs: 456
      });

      expect(draft.artistNames).toEqual(testCase.expectedArtists);
    }
  });

  it("upserts one playable song row per NAS file", async () => {
    const db = createRecordingDb();
    const drafts: KtvIndexAssetDraft[] = [
      createDraft({ filePath: "/media/a.mkv" }),
      createDraft({ filePath: "/media/b.mpg" })
    ];

    const result = await indexKtvAssetDrafts(db, {
      sourceRoot: "/media",
      sshHost: "lxc-nas",
      drafts,
      batchSize: 1
    });

    expect(result).toMatchObject({
      filesSeen: 2,
      songsUpserted: 2,
      assetsUpserted: 2
    });
    expect(db.queries.map((query) => query.text)).toEqual(expect.arrayContaining([
      expect.stringContaining("INSERT INTO ktv_songs"),
      expect.stringContaining("ON CONFLICT (file_path)")
    ]));
    expect(db.queries.map((query) => query.text).join("\n")).not.toContain("ktv_song_assets");
    expect(db.queries.map((query) => query.text).join("\n")).not.toContain("ktv_artists");
  });

  it("marks previously indexed assets missing during a full rebuild", async () => {
    const db = createRecordingDb();

    const result = await indexKtvAssetDrafts(db, {
      sourceRoot: "/media",
      drafts: [createDraft({ filePath: "/media/current.mkv" })],
      markMissingAssets: true
    });

    expect(result.assetsMarkedMissing).toBe(3);
    expect(db.queries.map((query) => query.text)).toEqual(expect.arrayContaining([
      expect.stringContaining("UPDATE ktv_songs"),
      expect.stringContaining("last_seen_run_id IS DISTINCT FROM $1"),
      expect.stringContaining("missing_at IS NULL")
    ]));
  });

  it("preserves existing same-path metadata when preserveExisting is enabled", async () => {
    const db = createRecordingDb();

    await indexKtvAssetDrafts(db, {
      sourceRoot: "/media",
      drafts: [createDraft({ filePath: "/media/existing.mkv" })],
      preserveExisting: true
    });

    const upsertQuery = db.queries.find((query) => query.text.includes("ON CONFLICT (file_path)"));
    expect(upsertQuery?.text).toBeDefined();
    expect(upsertQuery?.text).toContain("last_seen_run_id = EXCLUDED.last_seen_run_id");
    expect(upsertQuery?.text).toContain("missing_at = NULL");
    expect(upsertQuery?.text).toContain("size_bytes = EXCLUDED.size_bytes");
    expect(upsertQuery?.text).not.toContain("title = EXCLUDED.title");
    expect(upsertQuery?.text).not.toContain("primary_artist_name = EXCLUDED.primary_artist_name");
    expect(upsertQuery?.text).not.toContain("artist_names = EXCLUDED.artist_names");
    expect(upsertQuery?.text).not.toContain("style_tags = EXCLUDED.style_tags");
    expect(upsertQuery?.text).not.toContain("parse_strategy = EXCLUDED.parse_strategy");
    expect(upsertQuery?.text).not.toContain("technical_status = EXCLUDED.technical_status");
    expect(upsertQuery?.text).not.toContain("technical_metadata = EXCLUDED.technical_metadata");
  });
});

function createDraft(overrides: Partial<KtvIndexAssetDraft> = {}): KtvIndexAssetDraft {
  return {
    title: "七里香",
    normalizedTitle: "七里香",
    titlePinyin: "qilixiang",
    titleInitials: "qlx",
    artistNames: ["周杰伦"],
    filePath: "/media/周杰伦-七里香-国语-流行.mkv",
    relativePath: "周杰伦-七里香-国语-流行.mkv",
    fileName: "周杰伦-七里香-国语-流行.mkv",
    extension: ".mkv",
    sizeBytes: null,
    mtimeMs: null,
    parseStrategy: "filename",
    parseConfidence: 0.98,
    technicalStatus: "pending",
    technicalMetadata: {},
    ...overrides
  };
}

function createRecordingDb(): QueryExecutor & { queries: Array<{ text: string; values: readonly unknown[] }> } {
  const queries: Array<{ text: string; values: readonly unknown[] }> = [];
  let idCounter = 0;
  const db: QueryExecutor & { queries: Array<{ text: string; values: readonly unknown[] }> } = {
    queries,
    async query<TRow>(text: string, values: readonly unknown[] = []) {
      queries.push({ text, values });
      if (text.includes("count(*)::int AS count")) {
        return { rows: [{ count: 3 }] as TRow[] };
      }
      if (text.includes("RETURNING id")) {
        idCounter += 1;
        return { rows: [{ id: `id-${idCounter}` }] as TRow[] };
      }
      return { rows: [] as TRow[] };
    }
  };
  return db;
}
