import type { ControllerUser, ControllerUserPhone } from "@home-ktv/domain";
import type { QueryExecutor } from "../../../db/query-executor.js";
import type { ControllerAuthSessionRow, ControllerUserRow } from "../../../db/schema.js";

export interface CreateControllerUserInput {
  phone: ControllerUserPhone;
  displayName: string;
  passwordHash: string;
  now: Date;
}

export interface CreateControllerAuthSessionInput {
  phone: ControllerUserPhone;
  tokenHash: string;
  expiresAt: Date;
  now: Date;
}

export interface FindUserByTokenInput {
  tokenHash: string;
  now: Date;
}

export interface TouchControllerAuthSessionInput extends FindUserByTokenInput {
  lastSeenAt: Date;
}

export interface RevokeControllerAuthSessionInput {
  tokenHash: string;
  now: Date;
}

export interface ControllerAuthRepository {
  createUser(input: CreateControllerUserInput): Promise<ControllerUser>;
  findUserByPhone(phone: ControllerUserPhone): Promise<(ControllerUser & { passwordHash: string }) | null>;
  updateDisplayName(input: { phone: ControllerUserPhone; displayName: string; now: Date }): Promise<ControllerUser | null>;
  createSession(input: CreateControllerAuthSessionInput): Promise<void>;
  findUserByToken(input: FindUserByTokenInput): Promise<ControllerUser | null>;
  touchSession(input: TouchControllerAuthSessionInput): Promise<void>;
  revokeSession(input: RevokeControllerAuthSessionInput): Promise<void>;
}

export class PgControllerAuthRepository implements ControllerAuthRepository {
  constructor(private readonly db: QueryExecutor) {}

  async createUser(input: CreateControllerUserInput): Promise<ControllerUser> {
    const result = await this.db.query<ControllerUserRow>(
      `INSERT INTO controller_users (phone, display_name, password_hash, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4)
       RETURNING phone, display_name, password_hash, created_at, updated_at, last_login_at`,
      [input.phone, input.displayName, input.passwordHash, input.now]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("Controller user insert did not return a row");
    }
    return mapUserRow(row);
  }

  async findUserByPhone(phone: ControllerUserPhone): Promise<(ControllerUser & { passwordHash: string }) | null> {
    const result = await this.db.query<ControllerUserRow>(
      `SELECT phone, display_name, password_hash, created_at, updated_at, last_login_at
       FROM controller_users
       WHERE phone = $1
       LIMIT 1`,
      [phone]
    );
    const row = result.rows[0];
    return row ? { ...mapUserRow(row), passwordHash: row.password_hash } : null;
  }

  async updateDisplayName(input: { phone: ControllerUserPhone; displayName: string; now: Date }): Promise<ControllerUser | null> {
    const result = await this.db.query<ControllerUserRow>(
      `UPDATE controller_users
       SET display_name = $2,
           updated_at = $3
       WHERE phone = $1
       RETURNING phone, display_name, password_hash, created_at, updated_at, last_login_at`,
      [input.phone, input.displayName, input.now]
    );
    const row = result.rows[0];
    return row ? mapUserRow(row) : null;
  }

  async createSession(input: CreateControllerAuthSessionInput): Promise<void> {
    await this.db.query<ControllerAuthSessionRow>(
      `INSERT INTO controller_auth_sessions (phone, token_hash, expires_at, last_seen_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4, $4)`,
      [input.phone, input.tokenHash, input.expiresAt, input.now]
    );
    await this.db.query(
      `UPDATE controller_users
       SET last_login_at = $2,
           updated_at = $2
       WHERE phone = $1`,
      [input.phone, input.now]
    );
  }

  async findUserByToken(input: FindUserByTokenInput): Promise<ControllerUser | null> {
    const result = await this.db.query<ControllerUserRow>(
      `SELECT u.phone, u.display_name, u.password_hash, u.created_at, u.updated_at, u.last_login_at
       FROM controller_auth_sessions s
       JOIN controller_users u ON u.phone = s.phone
       WHERE s.token_hash = $1
         AND s.revoked_at IS NULL
         AND s.expires_at > $2
       LIMIT 1`,
      [input.tokenHash, input.now]
    );
    const row = result.rows[0];
    return row ? mapUserRow(row) : null;
  }

  async touchSession(input: TouchControllerAuthSessionInput): Promise<void> {
    await this.db.query(
      `UPDATE controller_auth_sessions
       SET last_seen_at = $3,
           updated_at = $3
       WHERE token_hash = $1
         AND revoked_at IS NULL
         AND expires_at > $2`,
      [input.tokenHash, input.now, input.lastSeenAt]
    );
  }

  async revokeSession(input: RevokeControllerAuthSessionInput): Promise<void> {
    await this.db.query(
      `UPDATE controller_auth_sessions
       SET revoked_at = $2,
           updated_at = $2
       WHERE token_hash = $1
         AND revoked_at IS NULL`,
      [input.tokenHash, input.now]
    );
  }
}

export class InMemoryControllerAuthRepository implements ControllerAuthRepository {
  private readonly users = new Map<ControllerUserPhone, ControllerUser & { passwordHash: string }>();
  private readonly sessions = new Map<string, { phone: ControllerUserPhone; expiresAt: string; revokedAt: string | null; lastSeenAt: string }>();

  async createUser(input: CreateControllerUserInput): Promise<ControllerUser> {
    if (this.users.has(input.phone)) {
      throw new Error("USER_ALREADY_EXISTS");
    }
    const user: ControllerUser & { passwordHash: string } = {
      phone: input.phone,
      displayName: input.displayName,
      passwordHash: input.passwordHash,
      createdAt: input.now.toISOString(),
      updatedAt: input.now.toISOString(),
      lastLoginAt: null
    };
    this.users.set(input.phone, { ...user });
    return withoutPasswordHash(user);
  }

  async findUserByPhone(phone: ControllerUserPhone): Promise<(ControllerUser & { passwordHash: string }) | null> {
    const user = this.users.get(phone);
    return user ? { ...user } : null;
  }

  async updateDisplayName(input: { phone: ControllerUserPhone; displayName: string; now: Date }): Promise<ControllerUser | null> {
    const existing = this.users.get(input.phone);
    if (!existing) {
      return null;
    }
    const updated = {
      ...existing,
      displayName: input.displayName,
      updatedAt: input.now.toISOString()
    };
    this.users.set(input.phone, updated);
    return withoutPasswordHash(updated);
  }

  async createSession(input: CreateControllerAuthSessionInput): Promise<void> {
    this.sessions.set(input.tokenHash, {
      phone: input.phone,
      expiresAt: input.expiresAt.toISOString(),
      revokedAt: null,
      lastSeenAt: input.now.toISOString()
    });
    const user = this.users.get(input.phone);
    if (user) {
      this.users.set(input.phone, { ...user, lastLoginAt: input.now.toISOString(), updatedAt: input.now.toISOString() });
    }
  }

  async findUserByToken(input: FindUserByTokenInput): Promise<ControllerUser | null> {
    const session = this.sessions.get(input.tokenHash);
    if (!session || session.revokedAt !== null || new Date(session.expiresAt).getTime() <= input.now.getTime()) {
      return null;
    }
    const user = this.users.get(session.phone);
    return user ? withoutPasswordHash(user) : null;
  }

  async touchSession(input: TouchControllerAuthSessionInput): Promise<void> {
    const session = this.sessions.get(input.tokenHash);
    if (!session || session.revokedAt !== null || new Date(session.expiresAt).getTime() <= input.now.getTime()) {
      return;
    }
    this.sessions.set(input.tokenHash, { ...session, lastSeenAt: input.lastSeenAt.toISOString() });
  }

  async revokeSession(input: RevokeControllerAuthSessionInput): Promise<void> {
    const session = this.sessions.get(input.tokenHash);
    if (!session || session.revokedAt !== null) {
      return;
    }
    this.sessions.set(input.tokenHash, { ...session, revokedAt: input.now.toISOString() });
  }
}

function mapUserRow(row: ControllerUserRow): ControllerUser {
  return {
    phone: row.phone,
    displayName: row.display_name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastLoginAt: row.last_login_at?.toISOString() ?? null
  };
}

function withoutPasswordHash(user: ControllerUser & { passwordHash: string }): ControllerUser {
  const { passwordHash: _passwordHash, ...publicUser } = user;
  return publicUser;
}
