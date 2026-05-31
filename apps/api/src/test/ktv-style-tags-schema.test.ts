import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { schemaSql, tableNames } from "../db/schema.js";

const migrationUrl = new URL("../db/migrations/0013_ktv_style_tags.sql", import.meta.url);
const migrationSql = existsSync(migrationUrl) ? readFileSync(migrationUrl, "utf8") : "";
const cacheMigrationUrl = new URL("../db/migrations/0014_ktv_tagging_cache.sql", import.meta.url);
const cacheMigrationSql = existsSync(cacheMigrationUrl) ? readFileSync(cacheMigrationUrl, "utf8") : "";
const statusSourceMigrationUrl = new URL("../db/migrations/0015_ktv_tagging_status_per_source.sql", import.meta.url);
const statusSourceMigrationSql = existsSync(statusSourceMigrationUrl)
  ? readFileSync(statusSourceMigrationUrl, "utf8")
  : "";
const simplificationMigrationUrl = new URL("../db/migrations/0020_ktv_style_tags_simplification.sql", import.meta.url);
const simplificationMigrationSql = existsSync(simplificationMigrationUrl)
  ? readFileSync(simplificationMigrationUrl, "utf8")
  : "";

describe("KTV style tag schema", () => {
  it("stores style tags directly on ktv_songs in the final schema", () => {
    expect(schemaSql).toContain("style_tags text[] NOT NULL DEFAULT '{}'");
    expect(schemaSql).not.toContain("CREATE TABLE IF NOT EXISTS ktv_song_style_tags");
    expect(Object.values(tableNames)).not.toContain("ktv_song_style_tags");

    for (const removedTable of [
      "CREATE TABLE IF NOT EXISTS ktv_style_groups",
      "CREATE TABLE IF NOT EXISTS ktv_style_tags",
      "CREATE TABLE IF NOT EXISTS ktv_song_style_tags",
      "CREATE TABLE IF NOT EXISTS ktv_song_tagging_runs",
      "CREATE TABLE IF NOT EXISTS ktv_song_tagging_status",
      "CREATE TABLE IF NOT EXISTS ktv_song_tagging_cache"
    ]) {
      expect(schemaSql).not.toContain(removedTable);
    }
  });

  it("migrates the old normalized style tag tables into the simplified relation", () => {
    expect(`${migrationSql}\n${cacheMigrationSql}\n${statusSourceMigrationSql}`).toContain(
      "CREATE TABLE IF NOT EXISTS ktv_style_groups"
    );
    expect(simplificationMigrationSql).toContain("CREATE TABLE ktv_song_style_tags_new");
    expect(simplificationMigrationSql).toContain("JOIN ktv_style_tags");
    expect(simplificationMigrationSql).toContain("JOIN ktv_style_groups");
    expect(simplificationMigrationSql).toContain("GROUP BY st.song_id, t.name, g.name");
    expect(simplificationMigrationSql).toContain("ALTER TABLE ktv_song_style_tags_new RENAME TO ktv_song_style_tags");

    for (const droppedTable of [
      "DROP TABLE IF EXISTS ktv_song_tagging_cache",
      "DROP TABLE IF EXISTS ktv_song_tagging_status",
      "DROP TABLE IF EXISTS ktv_song_tagging_runs",
      "DROP TABLE IF EXISTS ktv_style_tags",
      "DROP TABLE IF EXISTS ktv_style_groups"
    ]) {
      expect(simplificationMigrationSql).toContain(droppedTable);
    }
  });

  it("removes the legacy ktv_songs category column from the final schema", () => {
    expect(schemaSql).not.toContain("category text NOT NULL");
    expect(schemaSql).not.toContain("UNIQUE (normalized_title, normalized_primary_artist_name, category)");
    expect(schemaSql).not.toContain("ktv_songs_normalized_title_artist_uq");
    expect(schemaSql).toContain("ktv_songs_file_path_uq");
  });
});
