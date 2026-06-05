import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshPairingToken, refreshRoomStatus } from "../api/client.js";

type RequestRecord = {
  url: string;
  method: string;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("admin api client", () => {
  it("exposes room status and pairing token helpers", async () => {
    const requests: RequestRecord[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const requestUrl = new URL(String(input), "http://admin.test");
        requests.push({ url: `${requestUrl.pathname}${requestUrl.search}`, method: init?.method ?? "GET" });

        if (requestUrl.pathname === "/admin/rooms/living-room") {
          return json({ room: { roomId: "living-room", roomSlug: "living-room", status: "active" } });
        }
        if (requestUrl.pathname === "/admin/rooms/living-room/pairing-token/refresh") {
          return json({ pairing: { tokenExpiresAt: "2026-05-04T10:30:45.000Z", controllerUrl: "url", qrPayload: "url" } });
        }
        return json({ error: "NOT_FOUND" }, 404);
      })
    );

    await refreshRoomStatus("living-room");
    await refreshPairingToken("living-room");

    expect(requests).toEqual([
      { url: "/admin/rooms/living-room", method: "GET" },
      { url: "/admin/rooms/living-room/pairing-token/refresh", method: "POST" }
    ]);
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
