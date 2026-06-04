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

describe("multi TV support", () => {
  it("keeps one active TV player per room and reports conflicts for additional TVs", async () => {
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
      status: "conflict",
      deviceSession: null,
      snapshot: {
        state: "conflict",
        conflict: {
          activeDeviceId: "tv-main",
          activeDeviceName: "客厅电视",
          kind: "active-player-conflict"
        }
      }
    });

    const snapshot = await createControlSnapshot(server);

    expect(snapshot.tvPresence).toMatchObject({
      online: true,
      onlineCount: 1
    });
    expect(snapshot.tvPresence.devices).toEqual([expect.objectContaining({ deviceId: "tv-main", deviceName: "客厅电视" })]);

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

  const controlSession = await server.inject({
    method: "POST",
    url: "/rooms/living-room/control-sessions",
    payload: {
      pairingToken,
      deviceId: "phone-a",
      deviceName: "Phone A"
    }
  });

  expect(controlSession.statusCode).toBe(200);
  return controlSession.json().snapshot;
}
