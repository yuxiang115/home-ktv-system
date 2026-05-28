import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { schemaSql } from "../db/schema.js";

const migrationUrl = new URL("../db/migrations/0013_ktv_style_tags.sql", import.meta.url);
const migrationSql = existsSync(migrationUrl) ? readFileSync(migrationUrl, "utf8") : "";
const cacheMigrationUrl = new URL("../db/migrations/0014_ktv_tagging_cache.sql", import.meta.url);
const cacheMigrationSql = existsSync(cacheMigrationUrl) ? readFileSync(cacheMigrationUrl, "utf8") : "";

describe("KTV style tag schema", () => {
  it("creates normalized style tag tables in migration and final schema", () => {
    for (const sql of [`${migrationSql}\n${cacheMigrationSql}`, schemaSql]) {
      for (const expected of [
        "CREATE TABLE IF NOT EXISTS ktv_style_groups",
        "CREATE TABLE IF NOT EXISTS ktv_style_tags",
        "CREATE TABLE IF NOT EXISTS ktv_song_style_tags",
        "CREATE TABLE IF NOT EXISTS ktv_song_tagging_runs",
        "CREATE TABLE IF NOT EXISTS ktv_song_tagging_status",
        "CREATE TABLE IF NOT EXISTS ktv_song_tagging_cache"
      ]) {
        expect(sql).toContain(expected);
      }
    }
  });

  it("removes the legacy ktv_songs category column from the final schema", () => {
    expect(schemaSql).not.toContain("category text NOT NULL");
    expect(schemaSql).not.toContain("UNIQUE (normalized_title, normalized_primary_artist_name, category)");
    expect(schemaSql).toContain("ktv_songs_normalized_title_artist_uq");
  });
});
