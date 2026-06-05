import Fastify from "fastify";
import type { Room } from "@home-ktv/domain";
import { registerAdminRoomsRoutes } from "../routes/admin-rooms.js";
import { describe, expect, it, vi } from "vitest";

describe("admin online task actions", () => {
  it("retires online candidate task action endpoints", async () => {
    const harness = createHarness();
    const server = Fastify({ logger: false });
    await registerAdminRoomsRoutes(server, harness.routeDependencies);

    const retry = await server.inject({
      method: "POST",
      url: "/admin/rooms/living-room/online-tasks/task-failed/retry"
    });
    const clean = await server.inject({
      method: "POST",
      url: "/admin/rooms/living-room/online-tasks/task-stale/clean"
    });
    const promote = await server.inject({
      method: "POST",
      url: "/admin/rooms/living-room/online-tasks/task-ready/promote"
    });

    expect(retry.statusCode).toBe(404);
    expect(clean.statusCode).toBe(404);
    expect(promote.statusCode).toBe(404);
    expect(harness.queueEntries.append).toHaveBeenCalledTimes(0);
  });
});

function createHarness() {
  const room: Room = {
    id: "living-room",
    slug: "living-room",
    name: "Living Room",
    status: "active",
    defaultPlayerDeviceId: null,
    createdAt: "2026-05-07T00:00:00.000Z",
    updatedAt: "2026-05-07T00:00:00.000Z"
  };
  const queueEntries = {
    append: vi.fn(),
    listEffectiveQueue: vi.fn(async () => []),
    listUndoableRemoved: vi.fn(async () => []),
    findById: vi.fn(async () => null),
    findCurrentForRoom: vi.fn(async () => null),
    markRemoved: vi.fn(async () => null),
    undoRemoved: vi.fn(async () => null),
    renumberQueue: vi.fn(async () => []),
    markCompleted: vi.fn(async () => null)
  };
  return {
    queueEntries,
    routeDependencies: {
      config: { publicBaseUrl: "http://ktv.local" } as never,
      rooms: {
        findBySlug: vi.fn(async (slug: string) => (slug === "living-room" ? room : null)),
        findById: vi.fn(async (roomId: string) => (roomId === "living-room" ? room : null))
      },
      pairingTokens: {} as never,
      playbackSessions: {} as never,
      queueEntries: queueEntries as never,
      assets: {} as never,
      songs: {} as never,
      controlSessions: {} as never,
      deviceSessions: {} as never
    }
  };
}
