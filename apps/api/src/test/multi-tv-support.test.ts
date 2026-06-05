import { describe, expect, it } from "vitest";
import { createServer } from "../server.js";

const serverConfig = {
  corsAllowedOrigins: [],
  databaseUrl: "",
  host: "0.0.0.0",
  mediaRoot: "/media-root",
  port: 4000,
  publicBaseUrl: "http://ktv.local",
  roomSlug: "living-room"
};

describe("single TV support", () => {
  it("treats the latest TV bootstrap as the only active player", async () => {
    const server = await createServer(serverConfig);

    const firstTv = await bootstrapTv(server, "tv-main", "客厅电视");
    const secondTv = await bootstrapTv(server, "tv-side", "餐厅电视");

    expect(firstTv.statusCode).toBe(200);
    expect(firstTv.json()).toMatchObject({
      status: "registered",
      deviceSession: {
        id: "tv-main",
        deviceName: "客厅电视"
      },
      snapshot: {
        conflict: null
      }
    });
    expect(secondTv.statusCode).toBe(200);
    expect(secondTv.json()).toMatchObject({
      status: "registered",
      deviceSession: {
        id: "tv-side",
        deviceName: "餐厅电视"
      },
      snapshot: {
        conflict: null
      }
    });

    const snapshot = await createControlSnapshot(server);

    expect(snapshot.tvPresence).toMatchObject({
      online: true,
      onlineCount: 1
    });
    expect(snapshot.tvPresence.devices).toEqual([expect.objectContaining({ deviceId: "tv-side", deviceName: "餐厅电视" })]);

    await server.close();
  });
});

async function bootstrapTv(server: Awaited<ReturnType<typeof createServer>>, deviceId: string, deviceName: string) {
  return server.inject({
    method: "POST",
    url: "/player/bootstrap",
    payload: {
      roomSlug: "living-room",
      deviceId,
      deviceName,
      capabilities: {
        runtime: "test-tv-player"
      }
    }
  });
}

async function createControlSnapshot(server: Awaited<ReturnType<typeof createServer>>) {
  const refreshed = await server.inject({
    method: "POST",
    url: "/admin/rooms/living-room/pairing-token/refresh"
  });
  const pairingToken = refreshed.json().pairing.token as string;
  const authCookie = await createAuthCookie(server);

  const controlSession = await server.inject({
    method: "POST",
    url: "/rooms/living-room/control-sessions",
    headers: { cookie: authCookie },
    payload: {
      pairingToken,
      deviceId: "phone-a",
      deviceName: "Phone A"
    }
  });

  expect(controlSession.statusCode).toBe(200);
  return controlSession.json().snapshot;
}

async function createAuthCookie(server: Awaited<ReturnType<typeof createServer>>): Promise<string> {
  const response = await server.inject({
    method: "POST",
    url: "/controller/auth/register",
    payload: {
      phone: "13800138000",
      password: "abcde",
      displayName: "阿飞"
    }
  });
  return extractNamedCookie(response.headers["set-cookie"], "ktv_controller_auth");
}

function extractNamedCookie(header: string | string[] | number | undefined, name: string): string {
  const value = Array.isArray(header) ? String(header[0] ?? "") : String(header ?? "");
  const match = value.match(new RegExp(`${name}=[^;]+`, "u"));
  if (!match) {
    throw new Error(`Missing ${name} cookie`);
  }
  return match[0];
}
