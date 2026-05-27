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
  it("creates normalized KTV index tables in migration and schemaSql", () => {
    for (const sql of [migrationSql, schemaSql]) {
      for (const expected of [
        "CREATE TABLE IF NOT EXISTS ktv_index_runs",
        "CREATE TABLE IF NOT EXISTS ktv_artists",
        "CREATE TABLE IF NOT EXISTS ktv_songs",
        "CREATE TABLE IF NOT EXISTS ktv_song_artists",
        "CREATE TABLE IF NOT EXISTS ktv_song_assets"
      ]) {
        expect(sql).toContain(expected);
      }
    }

    expect(tableNames.ktvSongs).toBe("ktv_songs");
    expect(tableNames.ktvSongAssets).toBe("ktv_song_assets");
  });

  it("indexes title, artist, category, and path lookup columns", () => {
    for (const expected of [
      "ktv_songs_normalized_title_trgm_idx",
      "ktv_artists_normalized_name_trgm_idx",
      "ktv_songs_category_idx",
      "ktv_song_assets_path_uq"
    ]) {
      expect(migrationSql).toContain(expected);
      expect(schemaSql).toContain(expected);
    }
  });

  it("adds partial indexes for active playable assets", () => {
    for (const expected of [
      "ktv_song_assets_active_song_idx",
      "WHERE missing_at IS NULL"
    ]) {
      expect(activeAssetIndexMigrationSql).toContain(expected);
      expect(schemaSql).toContain(expected);
    }
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
      category: "流行",
      filePath: "/mnt/nas/KTV歌曲/流行歌曲(2.5万首880G)/推荐0001/谢金燕-练舞功(MTV)-闽南语-流行.mkv",
      relativePath: "流行歌曲(2.5万首880G)/推荐0001/谢金燕-练舞功(MTV)-闽南语-流行.mkv",
      technicalStatus: "pending"
    });
  });

  it("upserts one song with multiple assets for duplicate title and artist", async () => {
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
      expect.stringContaining("INSERT INTO ktv_index_runs"),
      expect.stringContaining("INSERT INTO ktv_artists"),
      expect.stringContaining("INSERT INTO ktv_songs"),
      expect.stringContaining("INSERT INTO ktv_song_assets")
    ]));
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
      expect.stringContaining("UPDATE ktv_song_assets"),
      expect.stringContaining("last_seen_run_id IS DISTINCT FROM $1"),
      expect.stringContaining("missing_at IS NULL")
    ]));
  });
});

function createDraft(overrides: Partial<KtvIndexAssetDraft> = {}): KtvIndexAssetDraft {
  return {
    title: "七里香",
    normalizedTitle: "七里香",
    titlePinyin: "qilixiang",
    titleInitials: "qlx",
    artistNames: ["周杰伦"],
    category: "流行",
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
