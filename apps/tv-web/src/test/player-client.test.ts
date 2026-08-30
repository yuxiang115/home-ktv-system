import type { RoomSnapshot } from "@home-ktv/player-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createBrowserPlayerClient, PlayerClient } from "../runtime/player-client.js";

const originalFetch = globalThis.fetch;
const originalLocation = globalThis.location;

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: originalLocation
  });
});

describe("PlayerClient", () => {
  it("keeps browser fetch bound to globalThis when no custom fetch is provided", async () => {
    const seenThisValues: unknown[] = [];
    globalThis.fetch = function browserLikeFetch(this: unknown) {
      seenThisValues.push(this);
      if (this !== globalThis) {
        throw new TypeError("Illegal invocation");
      }

      return Promise.resolve(
        new Response(JSON.stringify(roomSnapshot()), {
          headers: {
            "Content-Type": "application/json"
          },
          status: 200
        })
      );
    } as typeof fetch;

    const client = new PlayerClient({
      apiBaseUrl: "http://192.168.5.58:4000",
      deviceId: "tv-active",
      deviceName: "Living Room TV",
      roomSlug: "living-room"
    });

    await expect(client.fetchSnapshot()).resolves.toMatchObject({
      roomSlug: "living-room",
      state: "idle"
    });
    expect(seenThisValues[0]).toBe(globalThis);
  });

  it("uses a deviceId runtime query parameter when provided", () => {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: {
        origin: "http://tv.local:4173",
        search:
          "?apiBaseUrl=http%3A%2F%2F192.168.5.58%3A4000&deviceName=SecondTV&deviceId=web-tv-uat-second"
      } as Location
    });

    const client = createBrowserPlayerClient();

    expect(client.deviceId).toBe("web-tv-uat-second");
  });

  it("defaults bare local TV preview URLs to the local API port", () => {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: {
        origin: "http://192.168.5.64:4273",
        search: "?deviceId=web-tv-preview"
      } as Location
    });

    const client = createBrowserPlayerClient();

    expect(client.createSnapshotSocketUrl()).toBe("ws://192.168.5.64:4002/rooms/living-room/realtime?deviceId=web-tv-preview&client=tv");
  });

  it("builds a TV realtime WebSocket URL from an HTTP API base", () => {
    const client = new PlayerClient({
      apiBaseUrl: "http://192.168.5.58:4000",
      deviceId: "tv-active",
      deviceName: "Living Room TV",
      roomSlug: "living-room"
    });

    expect(client.createSnapshotSocketUrl()).toBe("ws://192.168.5.58:4000/rooms/living-room/realtime?deviceId=tv-active&client=tv");
  });

  it("builds a secure TV realtime WebSocket URL from an HTTPS API base", () => {
    const client = new PlayerClient({
      apiBaseUrl: "https://ktv.local",
      deviceId: "tv active",
      deviceName: "Living Room TV",
      roomSlug: "living-room"
    });

    expect(client.createSnapshotSocketUrl()).toBe("wss://ktv.local/rooms/living-room/realtime?deviceId=tv+active&client=tv");
  });

  it("returns null lyrics on 404 but propagates server errors (so callers do not cache them as missing)", async () => {
    const client = new PlayerClient({
      apiBaseUrl: "http://192.168.5.58:4000",
      deviceId: "tv-active",
      deviceName: "Living Room TV",
      roomSlug: "living-room",
      fetchImpl: (async (input: RequestInfo | URL) => {
        if (String(input).includes("/asset-broken/")) {
          return new Response("boom", { status: 500 });
        }
        return new Response("LYRICS_NOT_FOUND", { status: 404 });
      }) as typeof fetch
    });

    await expect(client.fetchSongLyrics("asset-ok")).resolves.toBeNull();
    await expect(client.fetchKaraokeLyrics("asset-ok")).resolves.toBeNull();
    await expect(client.fetchSongLyrics("asset-broken")).rejects.toThrow("500");
    await expect(client.fetchKaraokeLyrics("asset-broken")).rejects.toThrow("500");
  });

  it("propagates network failures instead of swallowing them into null", async () => {
    const client = new PlayerClient({
      apiBaseUrl: "http://192.168.5.58:4000",
      deviceId: "tv-active",
      deviceName: "Living Room TV",
      roomSlug: "living-room",
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch
    });

    await expect(client.fetchSongLyrics("asset-1")).rejects.toThrow("fetch failed");
    await expect(client.fetchKaraokeLyrics("asset-1")).rejects.toThrow("fetch failed");
  });
});

function roomSnapshot(): RoomSnapshot {
  return {
    type: "room.snapshot",
    roomId: "living-room",
    roomSlug: "living-room",
    sessionVersion: 1,
    state: "idle",
    pairing: {
      roomSlug: "living-room",
      controllerUrl: "http://192.168.5.58:4000/controller?token=living-room.test",
      qrPayload: "http://192.168.5.58:4000/controller?token=living-room.test",
      token: "living-room.test",
      tokenExpiresAt: "2026-04-29T13:50:00.000Z"
    },
    currentTarget: null,
    switchTarget: null,
    conflict: null,
    notice: null,
    generatedAt: "2026-04-29T13:45:00.000Z"
  };
}
