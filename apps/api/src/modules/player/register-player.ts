import type { DeviceSession, DeviceSessionId, Room, RoomId } from "@home-ktv/domain";
import type { PairingInfo } from "@home-ktv/player-contracts";
import type { QueryExecutor } from "../../db/query-executor.js";
import type { RoomClientRow } from "../../db/schema.js";
import { getOrCreatePairingInfo } from "../rooms/pairing-token-service.js";
import type { RoomPairingTokenRepository } from "../rooms/repositories/pairing-token-repository.js";

export interface RegisterPlayerInput {
  room: Room;
  deviceId: string;
  deviceName: string;
  capabilities: Record<string, boolean | string | number>;
  controllerBaseUrl?: string;
  publicBaseUrl: string;
  repository: PlayerDeviceSessionRepository;
  pairingTokens: RoomPairingTokenRepository;
  now?: Date;
}

export interface RegisterPlayerResult {
  status: "registered";
  deviceSession: DeviceSession;
  pairing: PairingInfo;
}

export interface UpsertTvPlayerInput {
  roomId: RoomId;
  deviceId: string;
  deviceName: string;
  capabilities: Record<string, boolean | string | number>;
  pairingToken: string;
  now: Date;
}

export interface UpdateTvHeartbeatInput {
  roomId: RoomId;
  deviceId: string;
  now: Date;
}

export interface PlayerDeviceSessionRepository {
  findActiveTvPlayer(roomId: RoomId, activeAfter: Date): Promise<DeviceSession | null>;
  listActiveTvPlayers(roomId: RoomId, activeAfter: Date): Promise<DeviceSession[]>;
  upsertTvPlayer(input: UpsertTvPlayerInput): Promise<DeviceSession>;
  updateTvHeartbeat(input: UpdateTvHeartbeatInput): Promise<DeviceSession | null>;
}

export async function registerPlayer(input: RegisterPlayerInput): Promise<RegisterPlayerResult> {
  const now = input.now ?? new Date();
  const pairing = await getOrCreatePairingInfo({
    room: input.room,
    publicBaseUrl: input.publicBaseUrl,
    repository: input.pairingTokens,
    now,
    ...(input.controllerBaseUrl ? { controllerBaseUrl: input.controllerBaseUrl } : {})
  });
  const deviceSession = await input.repository.upsertTvPlayer({
    roomId: input.room.id,
    deviceId: input.deviceId,
    deviceName: input.deviceName,
    capabilities: input.capabilities,
    pairingToken: pairing.token,
    now
  });

  return {
    status: "registered",
    deviceSession,
    pairing
  };
}

function mapDeviceSessionRow(row: RoomClientRow): DeviceSession {
  return {
    id: row.id as DeviceSessionId,
    roomId: row.room_id as RoomId,
    deviceType: "tv",
    deviceName: row.device_name,
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    capabilities: row.capabilities as Record<string, boolean | string | number>,
    pairingToken: row.pairing_token,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

export class PgPlayerDeviceSessionRepository implements PlayerDeviceSessionRepository {
  constructor(private readonly db: QueryExecutor) {}

  async findActiveTvPlayer(roomId: RoomId, activeAfter: Date): Promise<DeviceSession | null> {
    const active = await this.listActiveTvPlayers(roomId, activeAfter);
    return active[0] ?? null;
  }

  async listActiveTvPlayers(roomId: RoomId, activeAfter: Date): Promise<DeviceSession[]> {
    const result = await this.db.query<RoomClientRow>(
      `SELECT id, room_id, client_type, device_id, device_name, last_seen_at, expires_at,
              revoked_at, capabilities, pairing_token, created_at, updated_at
       FROM room_clients
       WHERE room_id = $1
         AND client_type = 'tv'
         AND revoked_at IS NULL
         AND last_seen_at >= $2
       ORDER BY last_seen_at DESC, id ASC`,
      [roomId, activeAfter]
    );

    return result.rows.map(mapDeviceSessionRow);
  }

  async upsertTvPlayer(input: UpsertTvPlayerInput): Promise<DeviceSession> {
    await this.db.query(
      `UPDATE room_clients
       SET revoked_at = $3,
           updated_at = now()
       WHERE room_id = $1
         AND client_type = 'tv'
         AND device_id <> $2
         AND revoked_at IS NULL`,
      [input.roomId, input.deviceId, input.now]
    );

    const result = await this.db.query<RoomClientRow>(
      `INSERT INTO room_clients (id, room_id, client_type, device_id, device_name, last_seen_at, capabilities, pairing_token)
       VALUES ($1, $2, 'tv', $1, $3, $4, $5::jsonb, $6)
       ON CONFLICT (room_id, client_type, device_id) DO UPDATE
       SET room_id = EXCLUDED.room_id,
           device_name = EXCLUDED.device_name,
           last_seen_at = EXCLUDED.last_seen_at,
           capabilities = EXCLUDED.capabilities,
           pairing_token = EXCLUDED.pairing_token,
           revoked_at = NULL,
           updated_at = now()
       RETURNING id, room_id, client_type, device_id, device_name, last_seen_at, expires_at,
                 revoked_at, capabilities, pairing_token, created_at, updated_at`,
      [
        input.deviceId,
        input.roomId,
        input.deviceName,
        input.now,
        JSON.stringify(input.capabilities),
        input.pairingToken
      ]
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error("TV player upsert did not return a device session");
    }

    await this.db.query(`UPDATE rooms SET default_player_device_id = $1, updated_at = now() WHERE id = $2`, [
      row.id,
      input.roomId
    ]);

    return mapDeviceSessionRow(row);
  }

  async updateTvHeartbeat(input: UpdateTvHeartbeatInput): Promise<DeviceSession | null> {
    const result = await this.db.query<RoomClientRow>(
      `UPDATE room_clients
       SET last_seen_at = $3,
           updated_at = now()
       WHERE id = $1
         AND room_id = $2
         AND client_type = 'tv'
         AND revoked_at IS NULL
       RETURNING id, room_id, client_type, device_id, device_name, last_seen_at, expires_at,
                 revoked_at, capabilities, pairing_token, created_at, updated_at`,
      [input.deviceId, input.roomId, input.now]
    );

    const row = result.rows[0];
    return row ? mapDeviceSessionRow(row) : null;
  }
}
