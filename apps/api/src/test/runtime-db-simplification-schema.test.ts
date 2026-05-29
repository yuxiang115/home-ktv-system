import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { schemaSql, tableNames } from "../db/schema.js";

const migrationPath = resolve(process.cwd(), "src/db/migrations/0019_runtime_db_simplification.sql");
const migrationSql = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";

describe("runtime database simplification schema", () => {
  it("adds the room clients table and folds pairing/playback state into rooms", () => {
    expect(tableNames).toMatchObject({
      rooms: "rooms",
      roomClients: "room_clients",
      queueEntries: "queue_entries",
      ktvSongs: "ktv_songs"
    });
    expect(schemaSql).toContain("CREATE TABLE IF NOT EXISTS room_clients");
    expect(schemaSql).toContain("pairing_token_value text");
    expect(schemaSql).toContain("pairing_token_hash text");
    expect(schemaSql).toContain("pairing_token_expires_at timestamptz");
    expect(schemaSql).toContain("current_queue_entry_id text");
    expect(schemaSql).toContain("rooms_current_queue_entry_fk");
    expect(schemaSql).toContain("playback_version integer NOT NULL DEFAULT 1");
    expect(schemaSql).toContain("volume_percent integer NOT NULL DEFAULT 50");
  });

  it("removes obsolete runtime tables from schemaSql", () => {
    for (const tableName of [
      "room_pairing_tokens",
      "device_sessions",
      "control_sessions",
      "control_commands",
      "playback_sessions",
      "playback_events"
    ]) {
      expect(schemaSql).not.toContain(`CREATE TABLE IF NOT EXISTS ${tableName}`);
    }
  });

  it("stores persistent song request counts on ktv_songs", () => {
    expect(schemaSql).toContain("request_count integer NOT NULL DEFAULT 0");
    expect(schemaSql).toContain("last_requested_at timestamptz");
    expect(schemaSql).toContain("ktv_songs_request_count_idx");
  });

  it("migrates request counts, clears volatile runtime state, and drops obsolete runtime tables", () => {
    expect(migrationSql).toContain("0019_runtime_db_simplification");
    expect(migrationSql).toContain("UPDATE ktv_songs");
    expect(migrationSql).toContain("COUNT(*)::integer AS request_count");
    expect(migrationSql).toContain("DELETE FROM queue_entries");
    expect(migrationSql).toContain("DROP TABLE IF EXISTS playback_events");
    expect(migrationSql).toContain("DROP TABLE IF EXISTS playback_sessions");
    expect(migrationSql).toContain("DROP TABLE IF EXISTS control_commands");
    expect(migrationSql).toContain("DROP TABLE IF EXISTS control_sessions");
    expect(migrationSql).toContain("DROP TABLE IF EXISTS device_sessions");
    expect(migrationSql).toContain("DROP TABLE IF EXISTS room_pairing_tokens");
  });
});
