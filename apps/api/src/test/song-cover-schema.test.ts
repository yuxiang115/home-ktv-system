import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { schemaSql, tableNames } from "../db/schema.js";

const catalogMigrationSql = readFileSync(
  path.resolve(__dirname, "../db/migrations/0022_merge_song_cover_cache_into_ktv_songs.sql"),
  "utf8"
);

describe("song cover URL schema", () => {
  it("stores NAS cover URLs on ktv_songs instead of a separate cache table", () => {
    expect(schemaSql).toContain("cover_image_url text");
    expect(schemaSql).toContain("cover_updated_at timestamptz");
    expect(schemaSql).not.toContain("CREATE TABLE IF NOT EXISTS song_cover_cache");
    expect(schemaSql).not.toContain("song_cover_cache_status_idx");
    expect(Object.values(tableNames)).not.toContain("song_cover_cache");
  });

  it("migrates found NAS cover URLs before dropping the old cache table", () => {
    expect(catalogMigrationSql).toContain("ADD COLUMN IF NOT EXISTS cover_image_url text");
    expect(catalogMigrationSql).toContain("ADD COLUMN IF NOT EXISTS cover_updated_at timestamptz");
    expect(catalogMigrationSql).toContain("FROM song_cover_cache cover");
    expect(catalogMigrationSql).toContain("cover.source_kind = 'nas'");
    expect(catalogMigrationSql).toContain("cover.status = 'found'");
    expect(catalogMigrationSql).toContain("DROP TABLE IF EXISTS song_cover_cache");
  });
});
