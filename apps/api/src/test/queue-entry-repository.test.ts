import { describe, expect, it } from "vitest";
import type { QueryExecutor } from "../db/query-executor.js";
import { PgQueueEntryRepository } from "../modules/playback/repositories/queue-entry-repository.js";

const now = new Date("2026-05-01T10:00:00.000Z");

describe("PgQueueEntryRepository", () => {
  it("appends NAS queue entries by source-native identity", async () => {
    const db = new RecordingDb([
      {
        id: "queue-1",
        room_id: "living-room",
        source_type: "nas",
        nas_song_id: "ktv-song-1",
        nas_asset_id: "ktv-asset-1",
        online_song_id: null,
        online_asset_id: null,
        requested_by: "phone-a",
        queue_position: 1,
        status: "queued",
        priority: 0,
        playback_options: {},
        requested_at: now,
        started_at: null,
        ended_at: null,
        removed_at: null,
        removed_by_control_session_id: null,
        undo_expires_at: null
      }
    ]);

    const repository = new PgQueueEntryRepository(db);
    const entry = await repository.append({
      roomId: "living-room",
      source: { sourceType: "nas", songId: "ktv-song-1", assetId: "ktv-asset-1" },
      requestedBy: "phone-a",
      queuePosition: 1,
      requestedAt: now
    });

    expect(db.queries[0]).toContain("source_type, nas_song_id, nas_asset_id");
    expect(db.values[0]?.slice(1, 4)).toEqual(["nas", "ktv-song-1", "ktv-asset-1"]);
    expect(entry).toMatchObject({
      source: { sourceType: "nas", songId: "ktv-song-1", assetId: "ktv-asset-1" },
      songId: "ktv-song-1",
      assetId: "ktv-asset-1"
    });
  });

  it("counts global NAS song requests from ktv_songs persistent counters", async () => {
    const db = new RecordingDb([{ song_id: "ktv-song-1", request_count: "3" }]);
    const repository = new PgQueueEntryRepository(db);

    const counts = await repository.listGlobalSongRequestCounts(["ktv-song-1"]);

    expect(db.queries[0]).toContain("FROM ktv_songs");
    expect(db.queries[0]).toContain("id = ANY");
    expect(db.queries[0]).not.toContain("FROM queue_entries");
    expect(counts.get("ktv-song-1")).toBe(3);
  });

  it("increments ktv_songs counters when appending a NAS queue entry", async () => {
    const db = new RecordingDb([
      {
        id: "queue-1",
        room_id: "living-room",
        source_type: "nas",
        nas_song_id: "ktv-song-1",
        nas_asset_id: "ktv-asset-1",
        online_song_id: null,
        online_asset_id: null,
        requested_by: "phone-a",
        queue_position: 1,
        status: "queued",
        priority: 0,
        playback_options: {},
        requested_at: now,
        started_at: null,
        ended_at: null,
        removed_at: null,
        removed_by_control_session_id: null,
        undo_expires_at: null
      }
    ]);
    const repository = new PgQueueEntryRepository(db);

    await repository.append({
      roomId: "living-room",
      source: { sourceType: "nas", songId: "ktv-song-1", assetId: "ktv-asset-1" },
      requestedBy: "phone-a",
      queuePosition: 1,
      requestedAt: now
    });

    expect(db.queries[1]).toContain("UPDATE ktv_songs");
    expect(db.queries[1]).toContain("request_count = request_count + 1");
    expect(db.queries[1]).toContain("last_requested_at");
    expect(db.values[1]).toEqual(["ktv-song-1", now]);
  });
});

class RecordingDb implements QueryExecutor {
  readonly queries: string[] = [];
  readonly values: (readonly unknown[] | undefined)[] = [];

  constructor(private readonly rows: Record<string, unknown>[]) {}

  async query<TRow>(text: string, values?: readonly unknown[]) {
    this.queries.push(text);
    this.values.push(values);
    return { rows: this.rows as TRow[] };
  }
}
