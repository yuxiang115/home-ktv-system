import type { RoomId, RoomPairingToken } from "@home-ktv/domain";
import type { QueryExecutor } from "../../../db/query-executor.js";
import type { RoomPairingTokenRow } from "../../../db/schema.js";

export interface UpsertRoomPairingTokenInput {
  roomId: RoomId;
  tokenValue: string;
  tokenHash: string;
  tokenExpiresAt: Date;
  now: Date;
}

export interface RoomPairingTokenRepository {
  findByRoomId(roomId: RoomId): Promise<RoomPairingToken | null>;
  upsert(input: UpsertRoomPairingTokenInput): Promise<RoomPairingToken>;
}

function mapRoomPairingTokenRow(row: RoomPairingTokenRow): RoomPairingToken {
  if (
    row.token_value === null ||
    row.token_hash === null ||
    row.token_expires_at === null ||
    row.rotated_at === null
  ) {
    throw new Error(`Room ${row.room_id} does not have a complete pairing token`);
  }

  return {
    roomId: row.room_id as RoomId,
    tokenValue: row.token_value,
    tokenHash: row.token_hash,
    tokenExpiresAt: row.token_expires_at.toISOString(),
    rotatedAt: row.rotated_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

export class PgRoomPairingTokenRepository implements RoomPairingTokenRepository {
  constructor(private readonly db: QueryExecutor) {}

  async findByRoomId(roomId: RoomId): Promise<RoomPairingToken | null> {
    const result = await this.db.query<RoomPairingTokenRow>(
      `SELECT id AS room_id,
              pairing_token_value AS token_value,
              pairing_token_hash AS token_hash,
              pairing_token_expires_at AS token_expires_at,
              pairing_token_rotated_at AS rotated_at,
              created_at,
              updated_at
       FROM rooms
       WHERE id = $1
         AND pairing_token_value IS NOT NULL
         AND pairing_token_hash IS NOT NULL
         AND pairing_token_expires_at IS NOT NULL
         AND pairing_token_rotated_at IS NOT NULL
       LIMIT 1`,
      [roomId]
    );

    const row = result.rows[0];
    return row ? mapRoomPairingTokenRow(row) : null;
  }

  async upsert(input: UpsertRoomPairingTokenInput): Promise<RoomPairingToken> {
    const result = await this.db.query<RoomPairingTokenRow>(
      `UPDATE rooms
       SET pairing_token_value = $2,
           pairing_token_hash = $3,
           pairing_token_expires_at = $4,
           pairing_token_rotated_at = $5,
           updated_at = now()
       WHERE id = $1
       RETURNING id AS room_id,
                 pairing_token_value AS token_value,
                 pairing_token_hash AS token_hash,
                 pairing_token_expires_at AS token_expires_at,
                 pairing_token_rotated_at AS rotated_at,
                 created_at,
                 updated_at`,
      [input.roomId, input.tokenValue, input.tokenHash, input.tokenExpiresAt, input.now]
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error("Pairing token upsert did not return a row");
    }

    return mapRoomPairingTokenRow(row);
  }
}

export class InMemoryRoomPairingTokenRepository implements RoomPairingTokenRepository {
  private readonly tokens = new Map<RoomId, RoomPairingToken>();

  constructor(initialTokens: readonly RoomPairingToken[] = []) {
    for (const token of initialTokens) {
      this.tokens.set(token.roomId, { ...token });
    }
  }

  async findByRoomId(roomId: RoomId): Promise<RoomPairingToken | null> {
    const token = this.tokens.get(roomId);
    return token ? { ...token } : null;
  }

  async upsert(input: UpsertRoomPairingTokenInput): Promise<RoomPairingToken> {
    const nowIso = input.now.toISOString();
    const existing = this.tokens.get(input.roomId);
    const token: RoomPairingToken = {
      roomId: input.roomId,
      tokenValue: input.tokenValue,
      tokenHash: input.tokenHash,
      tokenExpiresAt: input.tokenExpiresAt.toISOString(),
      rotatedAt: nowIso,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso
    };

    this.tokens.set(input.roomId, token);
    return { ...token };
  }
}
