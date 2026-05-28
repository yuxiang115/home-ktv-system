import { describe, expect, it } from "vitest";
import type { QueryExecutor } from "../db/query-executor.js";
import { PgPlaybackSessionRepository } from "../modules/playback/repositories/playback-session-repository.js";

const now = new Date("2026-05-01T10:00:00.000Z");

describe("PgPlaybackSessionRepository", () => {
  it("starts a queue entry without reading or writing active_asset_id", async () => {
    const db = new RecordingDb([
      {
        room_id: "living-room",
        current_queue_entry_id: "queue-1",
        target_vocal_mode: "instrumental",
        player_state: "playing",
        player_position_ms: 0,
        next_queue_entry_id: null,
        version: 2,
        volume_percent: 80,
        media_started_at: now,
        updated_at: now
      }
    ]);
    const repository = new PgPlaybackSessionRepository(db);

    const session = await repository.startQueueEntry({
      roomId: "living-room",
      queueEntryId: "queue-1",
      targetVocalMode: "instrumental",
      playerState: "playing",
      playerPositionMs: 0,
      nextQueueEntryId: null,
      mediaStartedAt: now
    });

    expect(db.queries[0]).not.toContain("active_asset_id");
    expect(db.values[0]).not.toContain("asset-1");
    expect(session).toMatchObject({
      roomId: "living-room",
      currentQueueEntryId: "queue-1",
      activeAssetId: null
    });
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
