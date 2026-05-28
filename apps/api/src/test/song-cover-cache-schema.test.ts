import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { schemaSql, tableNames } from "../db/schema.js";

const migrationSql = readFileSync(
  path.resolve(__dirname, "../db/migrations/0017_nas_online_catalog_refactor.sql"),
  "utf8"
);

describe("song cover cache schema", () => {
  it("mirrors the cover cache table in migration and schemaSql", () => {
    expect(schemaSql).toContain("CREATE TABLE IF NOT EXISTS song_cover_cache");
    expect(schemaSql).toContain("source_kind text NOT NULL CHECK (source_kind IN ('nas', 'online'))");
    expect(schemaSql).toContain("status text NOT NULL");
    expect(schemaSql).toContain("UNIQUE (source_kind, source_song_id)");
    expect(schemaSql).toContain("song_cover_cache_status_idx");
    expect(migrationSql).toContain("UPDATE song_cover_cache");
    expect(migrationSql).toContain("SET source_kind = 'nas'");
    expect(migrationSql).toContain("WHERE source_kind = 'ktv-index'");
    expect(migrationSql).toContain("DELETE FROM song_cover_cache");
    expect(migrationSql).toContain("WHERE source_kind = 'formal'");
    expect(migrationSql).toContain("CHECK (source_kind IN ('nas', 'online'))");
    expect(tableNames.songCoverCache).toBe("song_cover_cache");
  });

  it("drops the legacy source_kind check before rewriting legacy values", () => {
    expect(migrationSql.indexOf("DROP CONSTRAINT IF EXISTS song_cover_cache_source_kind_check")).toBeLessThan(
      migrationSql.indexOf("SET source_kind = 'nas'")
    );
  });
});
