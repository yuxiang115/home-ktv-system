import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { schemaSql } from "../db/schema.js";

const migrationSql = readFileSync(
  resolve(process.cwd(), "src/db/migrations/0017_nas_online_catalog_refactor.sql"),
  "utf8"
);

describe("NAS / online catalog final schema", () => {
  it("removes legacy formal catalog tables from the final schema", () => {
    expect(schemaSql).not.toContain("CREATE TABLE IF NOT EXISTS songs");
    expect(schemaSql).not.toContain("CREATE TABLE IF NOT EXISTS assets");
    expect(schemaSql).not.toContain("CREATE TABLE IF NOT EXISTS source_records");
  });

  it("stores queue entries by source-native identities", () => {
    expect(schemaSql).toContain("source_type text NOT NULL CHECK (source_type IN ('nas', 'online'))");
    expect(schemaSql).toContain("nas_song_id text");
    expect(schemaSql).toContain("nas_asset_id text");
    expect(schemaSql).toContain("online_song_id text");
    expect(schemaSql).toContain("online_asset_id text");
    expect(schemaSql).toContain("queue_entries_source_identity_ck");
    expect(schemaSql).toContain("queue_entries_nas_asset_song_fk");
  });

  it("adds online placeholders and removes old active asset state", () => {
    expect(schemaSql).toContain("CREATE TABLE IF NOT EXISTS online_songs");
    expect(schemaSql).toContain("CREATE TABLE IF NOT EXISTS online_song_assets");
    expect(schemaSql).not.toContain("active_asset_id text REFERENCES assets");
  });

  it("uses nas and online as cover cache source kinds", () => {
    expect(schemaSql).toContain("source_kind text NOT NULL CHECK (source_kind IN ('nas', 'online'))");
    expect(schemaSql).not.toContain("'ktv-index'");
    expect(schemaSql).not.toContain("'formal'");
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
    expect(migrationSql).toContain("DROP TABLE IF EXISTS source_records");
    expect(migrationSql).toContain("DROP TABLE IF EXISTS import_candidate_files");
    expect(migrationSql).toContain("DROP TABLE IF EXISTS import_candidates");
    expect(migrationSql).toContain("DROP TABLE IF EXISTS import_files");
    expect(migrationSql).toContain("DROP TABLE IF EXISTS import_scan_runs");
    expect(migrationSql).toContain("DROP TABLE IF EXISTS assets");
    expect(migrationSql).toContain("DROP TABLE IF EXISTS songs");
  });
}
);
