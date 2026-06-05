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

describe("room interaction routes", () => {
  it("requires an active control session", async () => {
    const server = await createServer(serverConfig);

    const response = await server.inject({
      method: "POST",
      url: "/rooms/living-room/interactions",
      payload: {
        deviceId: "phone-a",
        kind: "emoji",
        message: "👏"
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "CONTROL_SESSION_REQUIRED" });
    await server.close();
  });

  it("broadcasts accepted interactions to realtime room subscribers", async () => {
    const server = await createServer(serverConfig);
    const cookie = await createControllerCookie(server);
    const messages: unknown[] = [];
    const socket = await server.injectWS(
      "/rooms/living-room/realtime?deviceId=tv-1&client=tv",
      {},
      {
        onInit: collectJsonMessages(messages)
      }
    );

    await waitFor(() => messages.some((message) => isSnapshotMessage(message)));
    messages.length = 0;

    const response = await server.inject({
      method: "POST",
      url: "/rooms/living-room/interactions",
      headers: {
        cookie
      },
      payload: {
        deviceId: "phone-a",
        kind: "blessing",
        message: "祝大家今晚唱得开心"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "accepted",
      interaction: {
        kind: "blessing",
        message: "祝大家今晚唱得开心",
        senderDeviceId: "phone-a",
        senderName: "Controller A"
      }
    });
    expect(String(response.headers["set-cookie"])).toContain("ktv_control_session=");

    await waitFor(() => messages.some((message) => isInteractionMessage(message)));
    expect(messages.find((message) => isInteractionMessage(message))).toMatchObject({
      type: "room.interaction.created",
      payload: {
        kind: "blessing",
        message: "祝大家今晚唱得开心"
      }
    });

    socket.close();
    await server.close();
  });

  it("bounds interaction message length by kind", async () => {
    const server = await createServer(serverConfig);
    const cookie = await createControllerCookie(server);

    const response = await server.inject({
      method: "POST",
      url: "/rooms/living-room/interactions",
      headers: {
        cookie
      },
      payload: {
        deviceId: "phone-a",
        kind: "bullet",
        message: "a".repeat(90)
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().interaction.message).toHaveLength(60);
    await server.close();
  });

  it("accepts rainbow praise and roast interaction kinds", async () => {
    const server = await createServer(serverConfig);
    const cookie = await createControllerCookie(server);

    const rainbowResponse = await server.inject({
      method: "POST",
      url: "/rooms/living-room/interactions",
      headers: {
        cookie
      },
      payload: {
        deviceId: "phone-a",
        kind: "rainbow_praise",
        message: "这一开嗓，客厅都亮了"
      }
    });
    const roastResponse = await server.inject({
      method: "POST",
      url: "/rooms/living-room/interactions",
      headers: {
        cookie
      },
      payload: {
        deviceId: "phone-a",
        kind: "roast",
        message: "这调跑得很有探索精神"
      }
    });

    expect(rainbowResponse.statusCode).toBe(200);
    expect(rainbowResponse.json().interaction).toMatchObject({ kind: "rainbow_praise", message: "这一开嗓，客厅都亮了" });
    expect(roastResponse.statusCode).toBe(200);
    expect(roastResponse.json().interaction).toMatchObject({ kind: "roast", message: "这调跑得很有探索精神" });
    await server.close();
  });

  it("keeps emoji interactions visible longer than text interactions", async () => {
    const server = await createServer(serverConfig);
    const cookie = await createControllerCookie(server);

    const bulletResponse = await server.inject({
      method: "POST",
      url: "/rooms/living-room/interactions",
      headers: {
        cookie
      },
      payload: {
        deviceId: "phone-a",
        kind: "bullet",
        message: "今晚开唱"
      }
    });
    const emojiResponse = await server.inject({
      method: "POST",
      url: "/rooms/living-room/interactions",
      headers: {
        cookie
      },
      payload: {
        deviceId: "phone-a",
        kind: "emoji",
        message: "🚀"
      }
    });

    const bullet = bulletResponse.json().interaction as { createdAt: string; expiresAt: string };
    const emoji = emojiResponse.json().interaction as { createdAt: string; expiresAt: string };
    const bulletTtlMs = new Date(bullet.expiresAt).getTime() - new Date(bullet.createdAt).getTime();
    const emojiTtlMs = new Date(emoji.expiresAt).getTime() - new Date(emoji.createdAt).getTime();

    expect(bulletTtlMs).toBe(7000);
    expect(emojiTtlMs).toBe(12000);
    expect(emojiTtlMs).toBeGreaterThan(bulletTtlMs);
    await server.close();
  });
});

async function createControllerCookie(server: Awaited<ReturnType<typeof createServer>>): Promise<string> {
  const authCookie = await createAuthCookie(server);
  const refreshed = await server.inject({
    method: "POST",
    url: "/admin/rooms/living-room/pairing-token/refresh"
  });
  const pairingToken = refreshed.json().pairing.token as string;
  const created = await server.inject({
    method: "POST",
    url: "/rooms/living-room/control-sessions",
    headers: { cookie: authCookie },
    payload: {
      pairingToken,
      deviceId: "phone-a",
      deviceName: "Controller A"
    }
  });

  return `${extractControlSessionCookie(created.headers["set-cookie"])}; ${authCookie}`;
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

function extractControlSessionCookie(header: string | string[] | number | undefined): string {
  return extractNamedCookie(header, "ktv_control_session");
}

function extractNamedCookie(header: string | string[] | number | undefined, name: string): string {
  const value = Array.isArray(header) ? header[0] ?? "" : String(header ?? "");
  const match = value.match(new RegExp(`${name}=[^;]+`, "u"));
  if (!match) {
    throw new Error(`Missing ${name} cookie`);
  }
  return match[0];
}

function collectJsonMessages(messages: unknown[]) {
  return (ws: { on(event: "message", listener: (data: unknown) => void): void }) => {
    ws.on("message", (data) => {
      const raw = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      messages.push(JSON.parse(raw));
    });
  };
}

function isSnapshotMessage(message: unknown): boolean {
  return Boolean(message && typeof message === "object" && (message as { type?: string }).type === "room.control.snapshot.updated");
}

function isInteractionMessage(message: unknown): boolean {
  return Boolean(message && typeof message === "object" && (message as { type?: string }).type === "room.interaction.created");
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}
