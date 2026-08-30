import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { InMemoryControllerAuthRepository } from "../modules/controller/repositories/controller-auth-repository.js";
import type { QueueEntryRepository } from "../modules/playback/repositories/queue-entry-repository.js";
import { registerControllerAuthRoutes } from "../routes/controller-auth.js";
import { registerControllerUserHistoryRoutes } from "../routes/controller-user-history.js";
import { createServer } from "../server.js";

const testConfig = {
  corsAllowedOrigins: [],
  databaseUrl: "",
  host: "0.0.0.0",
  mediaRoot: "/media-root",
  port: 4000,
  publicBaseUrl: "http://ktv.local",
  roomSlug: "living-room"
};

describe("controller auth routes", () => {
  it("registers a controller user, sets an auth cookie, and restores /me", async () => {
    const server = await createServer(testConfig);

    const registered = await server.inject({
      method: "POST",
      url: "/controller/auth/register",
      payload: {
        phone: "13800138000",
        password: "abcde",
        displayName: "阿飞"
      }
    });
    const authCookie = extractCookie(registered.headers["set-cookie"], "ktv_controller_auth");
    const me = await server.inject({
      method: "GET",
      url: "/controller/auth/me",
      headers: { cookie: authCookie }
    });

    expect(registered.statusCode).toBe(200);
    expect(registered.json()).toEqual({
      user: {
        phone: "13800138000",
        displayName: "阿飞"
      }
    });
    expect(String(registered.headers["set-cookie"])).toContain("HttpOnly; SameSite=Lax; Path=/; Max-Age=");
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ user: { phone: "13800138000", displayName: "阿飞" } });
    await server.close();
  });

  it("logs in, edits display name, and logs out", async () => {
    const server = await createServer(testConfig);
    await server.inject({
      method: "POST",
      url: "/controller/auth/register",
      payload: {
        phone: "13800138000",
        password: "abcde",
        displayName: "阿飞"
      }
    });

    const loggedIn = await server.inject({
      method: "POST",
      url: "/controller/auth/login",
      payload: {
        phone: "13800138000",
        password: "abcde"
      }
    });
    const authCookie = extractCookie(loggedIn.headers["set-cookie"], "ktv_controller_auth");
    const renamed = await server.inject({
      method: "PATCH",
      url: "/controller/auth/profile",
      headers: { cookie: authCookie },
      payload: { displayName: "小飞" }
    });
    const loggedOut = await server.inject({
      method: "POST",
      url: "/controller/auth/logout",
      headers: { cookie: authCookie }
    });
    const meAfterLogout = await server.inject({
      method: "GET",
      url: "/controller/auth/me",
      headers: { cookie: authCookie }
    });

    expect(loggedIn.statusCode).toBe(200);
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toEqual({ user: { phone: "13800138000", displayName: "小飞" } });
    expect(loggedOut.statusCode).toBe(204);
    expect(String(loggedOut.headers["set-cookie"])).toContain("ktv_controller_auth=;");
    expect(meAfterLogout.statusCode).toBe(401);
    expect(meAfterLogout.json()).toEqual({ code: "AUTH_REQUIRED" });
    await server.close();
  });

  it("rejects duplicate users, invalid login, and short passwords", async () => {
    const server = await createServer(testConfig);
    await server.inject({
      method: "POST",
      url: "/controller/auth/register",
      payload: {
        phone: "13800138000",
        password: "abcde",
        displayName: "阿飞"
      }
    });

    const duplicate = await server.inject({
      method: "POST",
      url: "/controller/auth/register",
      payload: {
        phone: "13800138000",
        password: "abcde",
        displayName: "阿飞"
      }
    });
    const shortPassword = await server.inject({
      method: "POST",
      url: "/controller/auth/register",
      payload: {
        phone: "13900139000",
        password: "abcd",
        displayName: "小飞"
      }
    });
    const invalidLogin = await server.inject({
      method: "POST",
      url: "/controller/auth/login",
      payload: {
        phone: "13800138000",
        password: "wrong-password"
      }
    });

    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({ code: "USER_ALREADY_EXISTS" });
    expect(shortPassword.statusCode).toBe(400);
    expect(shortPassword.json()).toEqual({ code: "INVALID_PASSWORD" });
    expect(invalidLogin.statusCode).toBe(401);
    expect(invalidLogin.json()).toEqual({ code: "INVALID_CREDENTIALS" });
    await server.close();
  });

  it("returns the authenticated controller user's song history only", async () => {
    const server = Fastify();
    const controllerAuth = new InMemoryControllerAuthRepository();
    const queueEntries = {
      listControllerUserSongHistory: async (phone: string) =>
        phone === "13800138000"
          ? [
              {
                songId: "ktv-song-sunny",
                assetId: "ktv-song-sunny",
                title: "晴天",
                artistName: "周杰伦",
                requestCount: 3,
                lastRequestedAt: "2026-06-05T10:00:00.000Z",
                hasLyrics: true
              },
              {
                songId: "ktv-song-rain",
                assetId: "ktv-song-rain",
                title: "雨天",
                artistName: "孙燕姿",
                requestCount: 1,
                lastRequestedAt: "2026-06-04T10:00:00.000Z",
                hasLyrics: false
              }
            ]
          : []
    } as unknown as QueueEntryRepository;
    await registerControllerAuthRoutes(server, { controllerAuth });
    await registerControllerUserHistoryRoutes(server, { controllerAuth, queueEntries });
    const registered = await server.inject({
      method: "POST",
      url: "/controller/auth/register",
      payload: {
        phone: "13800138000",
        password: "abcde",
        displayName: "阿飞"
      }
    });
    const authCookie = extractCookie(registered.headers["set-cookie"], "ktv_controller_auth");

    const guestHistory = await server.inject({
      method: "GET",
      url: "/controller/me/song-history"
    });
    const userHistory = await server.inject({
      method: "GET",
      url: "/controller/me/song-history",
      headers: { cookie: authCookie }
    });

    expect(guestHistory.statusCode).toBe(401);
    expect(guestHistory.json()).toEqual({ code: "AUTH_REQUIRED" });
    expect(userHistory.statusCode).toBe(200);
    expect(userHistory.json()).toEqual({
      songs: [
        {
          songId: "ktv-song-sunny",
          assetId: "ktv-song-sunny",
          title: "晴天",
          artistName: "周杰伦",
          requestCount: 3,
          lastRequestedAt: "2026-06-05T10:00:00.000Z",
          hasLyrics: true
        },
        {
          songId: "ktv-song-rain",
          assetId: "ktv-song-rain",
          title: "雨天",
          artistName: "孙燕姿",
          requestCount: 1,
          lastRequestedAt: "2026-06-04T10:00:00.000Z",
          hasLyrics: false
        }
      ]
    });
    await server.close();
  });
});

function extractCookie(header: unknown, name: string): string {
  const value = Array.isArray(header) ? header[0] : header;
  const cookie = String(value ?? "")
    .split(";")
    .find((part) => part.trim().startsWith(`${name}=`));
  if (!cookie) {
    throw new Error(`Missing cookie ${name}`);
  }
  return cookie.trim();
}
