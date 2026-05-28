import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { schemaSql, tableNames } from "../db/schema.js";

const migrationSql = readFileSync(
  path.resolve(__dirname, "../db/migrations/0016_song_cover_cache.sql"),
  "utf8"
);

describe("song cover cache schema", () => {
  it("mirrors the cover cache table in migration and schemaSql", () => {
    for (const sql of [migrationSql, schemaSql]) {
      expect(sql).toContain("CREATE TABLE IF NOT EXISTS song_cover_cache");
      expect(sql).toContain("source_kind text NOT NULL CHECK (source_kind IN ('formal', 'ktv-index'))");
      expect(sql).toContain("status text NOT NULL");
      expect(sql).toContain("UNIQUE (source_kind, source_song_id)");
      expect(sql).toContain("song_cover_cache_status_idx");
    }
    expect(tableNames.songCoverCache).toBe("song_cover_cache");
  });
});
