import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { schemaSql, tableNames } from "../db/schema.js";

const migrationSql = readFileSync(
  resolve(process.cwd(), "src/db/migrations/0017_nas_online_catalog_refactor.sql"),
  "utf8"
);
const cleanupMigrationPath = resolve(process.cwd(), "src/db/migrations/0018_drop_empty_queue_entries_unmapped_archive.sql");
const cleanupMigrationSql = existsSync(cleanupMigrationPath) ? readFileSync(cleanupMigrationPath, "utf8") : "";

describe("NAS / online catalog final schema", () => {
  it("removes legacy formal catalog tables from the final schema", () => {
    expect(schemaSql).not.toContain("CREATE TABLE IF NOT EXISTS songs");
    expect(schemaSql).not.toContain("CREATE TABLE IF NOT EXISTS assets");
    expect(schemaSql).not.toContain("CREATE TABLE IF NOT EXISTS source_records");
    expect(Object.values(tableNames)).not.toEqual(expect.arrayContaining([
      "songs",
      "assets",
      "source_records",
      "import_scan_runs",
      "import_files",
      "import_candidates",
      "import_candidate_files"
    ]));
  });

  it("stores queue entries as direct NAS song references", () => {
    expect(schemaSql).toContain("song_id text NOT NULL");
    expect(schemaSql).toContain("queue_entries_song_fk");
    expect(schemaSql).not.toContain("source_type text NOT NULL CHECK (source_type IN ('nas', 'online'))");
    expect(schemaSql).not.toContain("nas_song_id text");
    expect(schemaSql).not.toContain("nas_asset_id text");
    expect(schemaSql).not.toContain("online_song_id text");
    expect(schemaSql).not.toContain("online_asset_id text");
    expect(schemaSql).not.toContain("queue_entries_source_identity_ck");
    expect(schemaSql).not.toContain("queue_entries_nas_identity_ck");
  });

  it("keeps only ktv_songs for NAS and removes online placeholder tables and tasks", () => {
    expect(schemaSql).toContain("CREATE TABLE IF NOT EXISTS ktv_songs");
    expect(schemaSql).not.toContain("CREATE TABLE IF NOT EXISTS candidate_tasks");
    expect(Object.values(tableNames)).not.toContain("candidate_tasks");
    for (const removedTable of [
      "CREATE TABLE IF NOT EXISTS ktv_song_assets",
      "CREATE TABLE IF NOT EXISTS ktv_artists",
      "CREATE TABLE IF NOT EXISTS ktv_song_artists",
      "CREATE TABLE IF NOT EXISTS ktv_index_runs",
      "CREATE TABLE IF NOT EXISTS online_songs",
      "CREATE TABLE IF NOT EXISTS online_song_assets"
    ]) {
      expect(schemaSql).not.toContain(removedTable);
    }
    expect(schemaSql).toContain("file_path text NOT NULL");
    expect(schemaSql).toContain("artist_names text[] NOT NULL DEFAULT '{}'");
    expect(schemaSql).toContain("style_tags text[] NOT NULL DEFAULT '{}'");
    expect(schemaSql).not.toContain("active_asset_id text REFERENCES assets");
    expect(schemaSql).not.toContain("ready_asset_id text");
    expect(schemaSql).not.toContain("ready_source_type text CHECK (ready_source_type IN ('online'))");
    expect(schemaSql).not.toContain("ready_online_asset_id");
  });

  it("stores cover URLs on ktv_songs instead of retaining cover source-kind tables", () => {
    expect(schemaSql).toContain("cover_image_url text");
    expect(schemaSql).toContain("cover_updated_at timestamptz");
    expect(schemaSql).not.toContain("CREATE TABLE IF NOT EXISTS song_cover_cache");
    expect(schemaSql).not.toContain("source_kind text NOT NULL CHECK");
  });
});

describe("NAS / online catalog migration", () => {
  it("migrates legacy queue rows before dropping old columns", () => {
    expect(migrationSql).toContain("UPDATE queue_entries qe");
    expect(migrationSql).toContain("FROM source_records sr");
    expect(migrationSql).toContain("regexp_replace(qe.asset_id, '^asset-ktv-'");
    expect(migrationSql).toContain("ALTER TABLE queue_entries DROP COLUMN IF EXISTS song_id");
    expect(migrationSql).toContain("ALTER TABLE queue_entries DROP COLUMN IF EXISTS asset_id");
  });

  it("drops retired catalog and admission tables in the same release", () => {
    expect(migrationSql).toContain("DROP CONSTRAINT IF EXISTS import_candidates_default_candidate_file_fk");
    expect(migrationSql).toContain("DROP CONSTRAINT IF EXISTS songs_default_asset_fk");
    expect(migrationSql).toContain("DROP TABLE IF EXISTS source_records");
    expect(migrationSql).toContain("DROP TABLE IF EXISTS import_candidate_files");
    expect(migrationSql).toContain("DROP TABLE IF EXISTS import_candidates");
    expect(migrationSql).toContain("DROP TABLE IF EXISTS import_files");
    expect(migrationSql).toContain("DROP TABLE IF EXISTS import_scan_runs");
    expect(migrationSql).toContain("DROP TABLE IF EXISTS assets");
    expect(migrationSql).toContain("DROP TABLE IF EXISTS songs");
  });

  it("drops the empty unmapped queue archive only after guarding against data loss", () => {
    expect(cleanupMigrationSql).toContain("queue_entries_unmapped_archive");
    expect(cleanupMigrationSql).toContain("archive_has_rows");
    expect(cleanupMigrationSql).toContain("RAISE EXCEPTION");
    expect(cleanupMigrationSql).toContain("DROP TABLE public.queue_entries_unmapped_archive");
  });
});
