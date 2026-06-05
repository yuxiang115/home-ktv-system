import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import type { ControllerUser } from "@home-ktv/domain";
import type { ControllerAuthRepository } from "./repositories/controller-auth-repository.js";

export const CONTROLLER_AUTH_COOKIE = "ktv_controller_auth";
export const CONTROLLER_AUTH_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const passwordHashIterations = 120_000;
const passwordHashKeyLength = 32;
const passwordHashDigest = "sha256";

export interface AuthResult {
  user: ControllerUser;
  token: string;
}

export async function registerControllerUser(input: {
  phone: unknown;
  password: unknown;
  displayName: unknown;
  repository: ControllerAuthRepository;
  now?: Date;
}): Promise<AuthResult> {
  const now = input.now ?? new Date();
  const phone = normalizePhone(input.phone);
  const password = normalizePassword(input.password);
  const displayName = normalizeDisplayName(input.displayName);
  const existing = await input.repository.findUserByPhone(phone);
  if (existing) {
    throw new Error("USER_ALREADY_EXISTS");
  }

  const user = await input.repository.createUser({
    phone,
    displayName,
    passwordHash: hashPassword(password),
    now
  });
  return createControllerAuthSession({ user, repository: input.repository, now });
}

export async function loginControllerUser(input: {
  phone: unknown;
  password: unknown;
  repository: ControllerAuthRepository;
  now?: Date;
}): Promise<AuthResult> {
  const now = input.now ?? new Date();
  const phone = normalizePhone(input.phone);
  const password = normalizePassword(input.password, { enforceLength: false });
  const user = await input.repository.findUserByPhone(phone);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    throw new Error("INVALID_CREDENTIALS");
  }

  return createControllerAuthSession({ user, repository: input.repository, now });
}

export async function restoreControllerAuth(input: {
  cookieHeader: string | undefined;
  repository: ControllerAuthRepository;
  now?: Date;
}): Promise<ControllerUser | null> {
  const token = parseControllerAuthCookie(input.cookieHeader);
  if (!token) {
    return null;
  }
  const now = input.now ?? new Date();
  const tokenHash = hashToken(token);
  const user = await input.repository.findUserByToken({ tokenHash, now });
  if (!user) {
    return null;
  }
  await input.repository.touchSession({ tokenHash, now, lastSeenAt: now });
  return user;
}

export async function updateControllerProfile(input: {
  cookieHeader: string | undefined;
  displayName: unknown;
  repository: ControllerAuthRepository;
  now?: Date;
}): Promise<ControllerUser | null> {
  const now = input.now ?? new Date();
  const user = await restoreControllerAuth({ cookieHeader: input.cookieHeader, repository: input.repository, now });
  if (!user) {
    return null;
  }
  return input.repository.updateDisplayName({
    phone: user.phone,
    displayName: normalizeDisplayName(input.displayName),
    now
  });
}

export async function logoutControllerUser(input: {
  cookieHeader: string | undefined;
  repository: ControllerAuthRepository;
  now?: Date;
}): Promise<void> {
  const token = parseControllerAuthCookie(input.cookieHeader);
  if (!token) {
    return;
  }
  const now = input.now ?? new Date();
  await input.repository.revokeSession({ tokenHash: hashToken(token), now });
}

export function parseControllerAuthCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) {
    return null;
  }
  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rest] = part.trim().split("=");
    if (rawKey === CONTROLLER_AUTH_COOKIE) {
      return rest.join("=").trim() || null;
    }
  }
  return null;
}

export function serializeControllerAuthCookie(token: string): string {
  return `${CONTROLLER_AUTH_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(CONTROLLER_AUTH_TTL_MS / 1000)}`;
}

export function serializeControllerAuthClearCookie(): string {
  return `${CONTROLLER_AUTH_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function createControllerAuthSession(input: {
  user: ControllerUser;
  repository: ControllerAuthRepository;
  now: Date;
}): Promise<AuthResult> {
  const token = randomBytes(32).toString("base64url");
  return input.repository
    .createSession({
      phone: input.user.phone,
      tokenHash: hashToken(token),
      expiresAt: new Date(input.now.getTime() + CONTROLLER_AUTH_TTL_MS),
      now: input.now
    })
    .then(() => ({ user: input.user, token }));
}

function normalizePhone(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("INVALID_PHONE");
  }
  const phone = value.trim();
  if (!/^\d{5,20}$/u.test(phone)) {
    throw new Error("INVALID_PHONE");
  }
  return phone;
}

function normalizePassword(value: unknown, options: { enforceLength?: boolean } = {}): string {
  if (typeof value !== "string") {
    throw new Error("INVALID_PASSWORD");
  }
  if ((options.enforceLength ?? true) && value.length < 5) {
    throw new Error("INVALID_PASSWORD");
  }
  return value;
}

function normalizeDisplayName(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("INVALID_DISPLAY_NAME");
  }
  const displayName = value.trim();
  if (displayName.length === 0 || displayName.length > 24) {
    throw new Error("INVALID_DISPLAY_NAME");
  }
  return displayName;
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("base64url");
  const hash = pbkdf2Sync(password, salt, passwordHashIterations, passwordHashKeyLength, passwordHashDigest).toString("base64url");
  return `pbkdf2_${passwordHashDigest}$${passwordHashIterations}$${salt}$${hash}`;
}

function verifyPassword(password: string, storedHash: string): boolean {
  const [algorithm, iterationsText, salt, expected] = storedHash.split("$");
  if (algorithm !== `pbkdf2_${passwordHashDigest}` || !iterationsText || !salt || !expected) {
    return false;
  }
  const iterations = Number.parseInt(iterationsText, 10);
  if (!Number.isFinite(iterations) || iterations <= 0) {
    return false;
  }
  const actual = pbkdf2Sync(password, salt, iterations, passwordHashKeyLength, passwordHashDigest);
  const expectedBuffer = Buffer.from(expected, "base64url");
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}
