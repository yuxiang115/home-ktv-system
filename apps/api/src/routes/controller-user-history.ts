import type { FastifyInstance } from "fastify";
import { restoreControllerAuth } from "../modules/controller/controller-auth-service.js";
import type { ControllerAuthRepository } from "../modules/controller/repositories/controller-auth-repository.js";
import type { QueueEntryRepository } from "../modules/playback/repositories/queue-entry-repository.js";

export interface ControllerUserHistoryRouteDependencies {
  controllerAuth: ControllerAuthRepository;
  queueEntries: QueueEntryRepository;
}

export async function registerControllerUserHistoryRoutes(
  server: FastifyInstance,
  dependencies: ControllerUserHistoryRouteDependencies
): Promise<void> {
  server.get("/controller/me/song-history", async (request, reply) => {
    const user = await restoreControllerAuth({
      cookieHeader: request.headers.cookie,
      repository: dependencies.controllerAuth
    });
    if (!user) {
      await reply.code(401).send({ code: "AUTH_REQUIRED" });
      return;
    }

    const songs = await dependencies.queueEntries.listControllerUserSongHistory?.(user.phone, 100);
    await reply.send({ songs: songs ?? [] });
  });
}
