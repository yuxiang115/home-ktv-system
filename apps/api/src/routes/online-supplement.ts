import type { FastifyInstance, FastifyBaseLogger } from "fastify";
import type { SupplementWorkflowId } from "@home-ktv/domain";
import { restoreControlSession, serializeControlSessionCookie } from "../modules/controller/control-session-service.js";
import type { ControlSessionRepository } from "../modules/controller/repositories/control-session-repository.js";
import type { OnlineProvider, OnlineSearchCandidate } from "../modules/online-supplement/online-provider.js";
import type { OnlineSupplementTaskRepository } from "../modules/online-supplement/supplement-task-repository.js";
import type { RoomRepository } from "../modules/rooms/repositories/room-repository.js";

export interface OnlineSupplementRouteDependencies {
  rooms: RoomRepository;
  controlSessions: ControlSessionRepository;
  supplementTasks: OnlineSupplementTaskRepository;
  provider: OnlineProvider;
  workflowId: SupplementWorkflowId;
  enabled: boolean;
  /** 任务创建/复活后触发 pg_notify,让 API 立即广播快照(手机端马上看到"处理中") */
  notifyTaskChange?: (roomId: string) => Promise<void>;
  log?: FastifyBaseLogger;
}

interface OnlineSupplementSearchQuery {
  q?: string;
  limit?: string | number;
  deviceId?: string;
}

interface OnlineSupplementRequestBody {
  deviceId?: string;
  provider?: string;
  providerCandidateId?: string;
  sourceUrl?: string;
  title?: string;
  artistName?: string;
  durationMs?: number | null;
  workflowId?: SupplementWorkflowId;
}

export async function registerOnlineSupplementRoutes(
  server: FastifyInstance,
  dependencies: OnlineSupplementRouteDependencies
): Promise<void> {
  server.get<{ Params: { roomSlug: string }; Querystring: OnlineSupplementSearchQuery }>(
    "/rooms/:roomSlug/online-supplement/search",
    async (request, reply) => {
      if (!dependencies.enabled) {
        await reply.code(503).send({ code: "ONLINE_SUPPLEMENT_DISABLED" });
        return;
      }

      const room = await dependencies.rooms.findBySlug(request.params.roomSlug);
      if (!room) {
        await reply.code(404).send({ code: "ROOM_NOT_FOUND" });
        return;
      }

      const deviceId = trimmedText(request.query.deviceId);
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

      const query = trimmedText(request.query.q) ?? "";
      const rawLimit = request.query.limit;
      const parsedLimit =
        typeof rawLimit === "number" ? Math.trunc(rawLimit) : Number.parseInt(String(rawLimit ?? ""), 10);
      const limit = Math.min(20, Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : 8));

      let candidates: OnlineSearchCandidate[];
      try {
        candidates = await dependencies.provider.search({ query, limit });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        dependencies.log?.warn({ roomSlug: request.params.roomSlug, query, message }, "online supplement search failed");
        await reply.code(502).send({
          code: "ONLINE_SUPPLEMENT_SEARCH_FAILED",
          message
        });
        return;
      }

      dependencies.log?.info(
        { roomSlug: request.params.roomSlug, query, hits: candidates.length },
        "online supplement search"
      );
      reply.header("Set-Cookie", serializeControlSessionCookie({ session: { id: controlSession.id } }));
      await reply.send({ query, candidates });
    }
  );

  server.post<{ Params: { roomSlug: string }; Body: OnlineSupplementRequestBody }>(
    "/rooms/:roomSlug/online-supplement/request",
    async (request, reply) => {
      if (!dependencies.enabled) {
        await reply.code(503).send({ code: "ONLINE_SUPPLEMENT_DISABLED" });
        return;
      }

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

      const provider = trimmedText(request.body.provider);
      const providerCandidateId = trimmedText(request.body.providerCandidateId);
      const sourceUrl = trimmedText(request.body.sourceUrl);
      const title = trimmedText(request.body.title);
      if (!provider || !providerCandidateId || !sourceUrl || !title) {
        await reply.code(400).send({
          code: "INVALID_SUPPLEMENT_REQUEST",
          message: "provider, providerCandidateId, sourceUrl, title are required"
        });
        return;
      }

      const durationMs =
        typeof request.body.durationMs === "number" && request.body.durationMs >= 0
          ? Math.trunc(request.body.durationMs)
          : null;
      const workflowId = request.body.workflowId ?? dependencies.workflowId;

      const task = await dependencies.supplementTasks.createTask({
        roomId: room.id,
        provider,
        providerCandidateId,
        sourceUrl,
        title,
        artistName: trimmedText(request.body.artistName) ?? "",
        durationMs,
        providerPayload: {},
        workflowId,
        requestedBy: controlSession.id,
        now: new Date()
      });

      dependencies.log?.info(
        { roomSlug: request.params.roomSlug, taskId: task.id, title, status: task.status, stage: task.stage },
        "online supplement task submitted"
      );
      await dependencies.notifyTaskChange?.(room.id).catch((error: unknown) => {
        dependencies.log?.warn({ roomId: room.id, error }, "online supplement notify failed");
      });

      reply.header("Set-Cookie", serializeControlSessionCookie({ session: { id: controlSession.id } }));
      await reply.send({
        status: "accepted",
        taskId: task.id,
        taskStatus: task.status,
        stage: task.stage
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
