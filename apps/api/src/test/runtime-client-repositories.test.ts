import { describe, expect, it } from "vitest";
import type { QueryExecutor } from "../db/query-executor.js";
import { PgControlSessionRepository } from "../modules/controller/repositories/control-session-repository.js";
import { PgPlayerDeviceSessionRepository } from "../modules/player/register-player.js";
import { PgRoomPairingTokenRepository } from "../modules/rooms/repositories/pairing-token-repository.js";

const now = new Date("2026-05-01T10:00:00.000Z");
const expiresAt = new Date("2026-05-01T12:00:00.000Z");

describe("runtime client repositories", () => {
  it("stores room pairing tokens on rooms", async () => {
    const db = new RecordingDb([
      {
        room_id: "living-room",
        token_value: "token-1",
        token_hash: "hash-1",
        token_expires_at: expiresAt,
        rotated_at: now,
        created_at: now,
        updated_at: now
      }
    ]);
    const repository = new PgRoomPairingTokenRepository(db);

    const token = await repository.upsert({
      roomId: "living-room",
      tokenValue: "token-1",
      tokenHash: "hash-1",
      tokenExpiresAt: expiresAt,
      now
    });

    expect(db.queries[0]).toContain("UPDATE rooms");
    expect(db.queries[0]).not.toContain("room_pairing_tokens");
    expect(token.tokenValue).toBe("token-1");
  });

  it("stores controller sessions as controller room clients", async () => {
    const db = new RecordingDb([
      {
        id: "client-1",
        room_id: "living-room",
        client_type: "controller",
        device_id: "phone-1",
        device_name: "Phone",
        last_seen_at: now,
        expires_at: expiresAt,
        revoked_at: null,
        capabilities: {},
        pairing_token: null,
        created_at: now,
        updated_at: now
      }
    ]);
    const repository = new PgControlSessionRepository(db);

    const session = await repository.upsertForDevice({
      roomId: "living-room",
      deviceId: "phone-1",
      deviceName: "Phone",
      lastSeenAt: now,
      expiresAt,
      now
    });

    expect(db.queries[0]).toContain("INSERT INTO room_clients");
    expect(db.queries[0]).toContain("'controller'");
    expect(db.queries[0]).not.toContain("control_sessions");
    expect(session.deviceId).toBe("phone-1");
  });

  it("stores TV sessions as tv room clients", async () => {
    const db = new RecordingDb([
      {
        id: "tv-1",
        room_id: "living-room",
        client_type: "tv",
        device_id: "tv-1",
        device_name: "Living Room TV",
        last_seen_at: now,
        expires_at: null,
        revoked_at: null,
        capabilities: { audio: true },
        pairing_token: "token-1",
        created_at: now,
        updated_at: now
      }
    ]);
    const repository = new PgPlayerDeviceSessionRepository(db);

    const session = await repository.upsertTvPlayer({
      roomId: "living-room",
      deviceId: "tv-1",
      deviceName: "Living Room TV",
      capabilities: { audio: true },
      pairingToken: "token-1",
      now
    });

    expect(db.queries[0]).toContain("INSERT INTO room_clients");
    expect(db.queries[0]).toContain("'tv'");
    expect(db.queries[0]).not.toContain("device_sessions");
    expect(db.queries[1]).toContain("UPDATE rooms SET default_player_device_id = $1");
    expect(session.deviceName).toBe("Living Room TV");
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
