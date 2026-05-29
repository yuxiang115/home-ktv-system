import { existsSync, readFileSync } from "node:fs";
import type {
  ControlCommandResultStatus,
  ControlCommandType,
  ControlSession,
  RoomPairingToken
} from "@home-ktv/domain";
import type { ControlSessionInfo, RoomControlSnapshot } from "@home-ktv/player-contracts";
import { schemaSql } from "../db/schema";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL("../db/migrations/0019_runtime_db_simplification.sql", import.meta.url);
const migrationSql = existsSync(migrationUrl)
  ? readFileSync(migrationUrl, "utf8")
  : "";

const schemaSources = [migrationSql, schemaSql];

describe("room control session schema contracts", () => {
  it("folds pairing token and control session state into rooms and room_clients", () => {
    for (const sql of schemaSources) {
      expect(sql).toContain("pairing_token_value text");
      expect(sql).toContain("pairing_token_hash text");
      expect(sql).toContain("pairing_token_expires_at timestamptz");
      expect(sql).toContain("CREATE TABLE IF NOT EXISTS room_clients");
      expect(sql).toContain("client_type text NOT NULL CHECK (client_type IN ('tv', 'controller'))");
    }
  });

  it("stores displayable pairing tokens alongside verification hashes until expiry", () => {
    for (const sql of schemaSources) {
      expect(sql).toContain("pairing_token_value text");
      expect(sql).toContain("pairing_token_hash text");
      expect(sql).toContain("pairing_token_expires_at timestamptz");
    }
  });

  it("tracks restorable control sessions with idle expiry and revocation", () => {
    for (const sql of schemaSources) {
      expect(sql).toContain("device_id text NOT NULL");
      expect(sql).toContain("last_seen_at timestamptz");
      expect(sql).toContain("expires_at timestamptz");
      expect(sql).toContain("revoked_at timestamptz");
      expect(sql).toContain("room_clients_controller_expiry_ck");
    }
  });

  it("does not persist control commands in the final schema", () => {
    expect(schemaSql).not.toContain("CREATE TABLE IF NOT EXISTS control_commands");
    expect(schemaSql).not.toContain("command_id text PRIMARY KEY");
    expect(migrationSql).toContain("DROP TABLE IF EXISTS control_commands");
  });

  it("exports domain control session and command contracts", () => {
    const commandType = "switch-vocal-mode" satisfies ControlCommandType;
    const resultStatus = "accepted" satisfies ControlCommandResultStatus;
    const pairingToken = {
      roomId: "living-room",
      tokenValue: "opaque-token",
      tokenHash: "hash",
      tokenExpiresAt: "2026-05-01T14:00:00.000Z",
      rotatedAt: "2026-05-01T13:45:00.000Z",
      createdAt: "2026-05-01T13:45:00.000Z",
      updatedAt: "2026-05-01T13:45:00.000Z"
    } satisfies RoomPairingToken;
    const controlSession = {
      id: "session-1",
      roomId: "living-room",
      deviceId: "phone-1",
      deviceName: "Mobile Controller",
      lastSeenAt: "2026-05-01T13:45:00.000Z",
      expiresAt: "2026-05-01T15:45:00.000Z",
      revokedAt: null,
      createdAt: "2026-05-01T13:45:00.000Z",
      updatedAt: "2026-05-01T13:45:00.000Z"
    } satisfies ControlSession;

    expect([commandType, resultStatus, pairingToken.roomId, controlSession.deviceId]).toEqual([
      "switch-vocal-mode",
      "accepted",
      "living-room",
      "phone-1"
    ]);
  });

  it("exports a mobile room control snapshot with full control room state", () => {
    const session = {
      id: "session-1",
      roomId: "living-room",
      roomSlug: "living-room",
      deviceId: "phone-1",
      deviceName: "Mobile Controller",
      expiresAt: "2026-05-01T15:45:00.000Z",
      lastSeenAt: "2026-05-01T13:45:00.000Z"
    } satisfies ControlSessionInfo;
    const snapshot = {
      type: "room.control.snapshot",
      roomId: "living-room",
      roomSlug: "living-room",
      sessionVersion: 7,
      state: "playing",
      pairing: {
        roomSlug: "living-room",
        controllerUrl: "http://localhost:5173/rooms/living-room",
        qrPayload: "http://localhost:5173/rooms/living-room?token=opaque-token",
        token: "opaque-token",
        tokenExpiresAt: "2026-05-01T14:00:00.000Z"
      },
      tvPresence: {
        online: true,
        deviceName: "Living Room TV",
        lastSeenAt: "2026-05-01T13:45:00.000Z",
        onlineCount: 1,
        devices: [
          {
            deviceId: "tv-1",
            deviceName: "Living Room TV",
            lastSeenAt: "2026-05-01T13:45:00.000Z"
          }
        ],
        conflict: null
      },
      controllers: {
        onlineCount: 2
      },
      currentTarget: null,
      switchTarget: null,
      queue: [
        {
          queueEntryId: "queue-1",
          sourceType: "nas",
          songId: "song-1",
          assetId: "asset-1",
          songTitle: "Song",
          artistName: "Artist",
          requestedBy: "phone-1",
          queuePosition: 1,
          status: "queued",
          canPromote: true,
          canDelete: true,
          undoExpiresAt: null
        }
      ],
      notice: null,
      generatedAt: "2026-05-01T13:45:00.000Z"
    } satisfies RoomControlSnapshot;

    expect(session.roomSlug).toBe("living-room");
    expect(snapshot.type).toBe("room.control.snapshot");
    expect(snapshot.queue[0]?.canPromote).toBe(true);
  });
});
