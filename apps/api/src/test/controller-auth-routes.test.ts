import { describe, expect, it } from "vitest";
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
