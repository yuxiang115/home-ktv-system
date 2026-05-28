import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { RoomInteractionEvent, RoomInteractionKind } from "@home-ktv/player-contracts";
import { restoreControlSession, serializeControlSessionCookie } from "../modules/controller/control-session-service.js";
import type { ControlSessionRepository } from "../modules/controller/repositories/control-session-repository.js";
import type { RoomSnapshotBroadcaster } from "../modules/realtime/room-snapshot-broadcaster.js";
import type { RoomRepository } from "../modules/rooms/repositories/room-repository.js";

export interface RoomInteractionsRouteDependencies {
  rooms: RoomRepository;
  controlSessions: ControlSessionRepository;
  broadcaster: RoomSnapshotBroadcaster;
}

interface RoomInteractionBody {
  deviceId?: string;
  kind?: RoomInteractionKind;
  message?: string;
}

const interactionTtlMsByKind = {
  emoji: 12_000,
  bullet: 7_000,
  blessing: 7_000
} as const satisfies Record<RoomInteractionKind, number>;
const maxMessageLengthByKind = {
  emoji: 8,
  bullet: 60,
  blessing: 80
} as const satisfies Record<RoomInteractionKind, number>;

export async function registerRoomInteractionRoutes(
  server: FastifyInstance,
  dependencies: RoomInteractionsRouteDependencies
): Promise<void> {
  server.post<{ Params: { roomSlug: string }; Body: RoomInteractionBody }>(
    "/rooms/:roomSlug/interactions",
    async (request, reply) => {
      const room = await dependencies.rooms.findBySlug(request.params.roomSlug);
      if (!room) {
        await reply.code(404).send({ code: "ROOM_NOT_FOUND" });
        return;
      }

      const deviceId = trimmedText(request.body.deviceId);
      if (!deviceId) {
        await reply.code(400).send({ code: "INVALID_DEVICE_ID", message: "deviceId is required" });
        return;
      }

      const controlSession = await restoreControlSession({
        room,
        cookieHeader: request.headers.cookie,
        deviceId,
        controlSessions: dependencies.controlSessions
      });
      if (!controlSession) {
        await reply.code(401).send({ code: "CONTROL_SESSION_REQUIRED" });
        return;
      }

      const kind = request.body.kind;
      if (!isInteractionKind(kind)) {
        await reply.code(400).send({ code: "INVALID_INTERACTION_KIND", message: "interaction kind is invalid" });
        return;
      }

      const message = normalizeMessage(request.body.message, maxMessageLengthByKind[kind]);
      if (!message) {
        await reply.code(400).send({ code: "INVALID_INTERACTION_MESSAGE", message: "interaction message is required" });
        return;
      }

      const now = new Date();
      const interaction: RoomInteractionEvent = {
        id: `interaction-${randomUUID()}`,
        roomId: room.id,
        roomSlug: room.slug,
        kind,
        message,
        senderDeviceId: deviceId,
        senderName: controlSession.deviceName,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + interactionTtlMsByKind[kind]).toISOString()
      };

      dependencies.broadcaster.broadcastRoomInteraction(room.slug, interaction);
      reply.header("Set-Cookie", serializeControlSessionCookie({ session: { id: controlSession.id } }));
      await reply.send({
        status: "accepted",
        interaction
      });
    }
  );
}

function trimmedText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function isInteractionKind(value: unknown): value is RoomInteractionKind {
  return value === "emoji" || value === "bullet" || value === "blessing";
}

function normalizeMessage(value: unknown, maxLength: number): string | null {
  const text = trimmedText(value);
  if (!text) {
    return null;
  }

  const normalized = text.replace(/\s+/gu, " ").slice(0, maxLength).trim();
  return normalized ? normalized : null;
}
