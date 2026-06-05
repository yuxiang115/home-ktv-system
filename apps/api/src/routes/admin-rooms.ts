import type { FastifyInstance } from "fastify";
import type { MediaSourceRef } from "@home-ktv/domain";
import type { ApiConfig } from "../config.js";
import { buildEmptyOnlineTaskSummary, buildRoomControlSnapshot } from "../modules/rooms/build-control-snapshot.js";
import { getOrCreatePairingInfo, refreshPairingToken } from "../modules/rooms/pairing-token-service.js";
import type { MediaGateway } from "../modules/media/media-gateway.js";
import type { PlayableMediaRepository } from "../modules/media/playable-media-repository.js";
import type { ControlSessionRepository } from "../modules/controller/repositories/control-session-repository.js";
import type { PlaybackSessionRepository } from "../modules/playback/repositories/playback-session-repository.js";
import type { QueueEntryRepository } from "../modules/playback/repositories/queue-entry-repository.js";
import type { QueueEntryStatus } from "@home-ktv/domain";
import type { RoomPairingTokenRepository } from "../modules/rooms/repositories/pairing-token-repository.js";
import type { RoomRepository } from "../modules/rooms/repositories/room-repository.js";
import type { PlayerDeviceSessionRepository } from "../modules/player/register-player.js";
import type { PlaybackEventRepository } from "../modules/playback/repositories/playback-event-repository.js";
import type { RoomSnapshotBroadcaster } from "../modules/realtime/room-snapshot-broadcaster.js";

export interface AdminRoomsRouteDependencies {
  config: ApiConfig;
  rooms: RoomRepository;
  pairingTokens: RoomPairingTokenRepository;
  playbackSessions: PlaybackSessionRepository;
  queueEntries: QueueEntryRepository;
  playableMedia?: PlayableMediaRepository;
  controlSessions: ControlSessionRepository;
  mediaGateway?: Pick<MediaGateway, "createPlaybackUrl">;
  deviceSessions: PlayerDeviceSessionRepository;
  playbackEvents?: Pick<PlaybackEventRepository, "listRecentByRoom"> | undefined;
  broadcaster?: RoomSnapshotBroadcaster | undefined;
}

export async function registerAdminRoomsRoutes(
  server: FastifyInstance,
  dependencies: AdminRoomsRouteDependencies
): Promise<void> {
  server.get<{ Params: { roomSlug: string } }>("/admin/rooms/:roomSlug", async (request, reply) => {
    const room = await dependencies.rooms.findBySlug(request.params.roomSlug);
    if (!room) {
      return reply.code(404).send({ error: "ROOM_NOT_FOUND" });
    }

    const snapshot = await buildRoomControlSnapshot({
      roomSlug: room.slug,
      config: dependencies.config,
      repositories: {
        rooms: dependencies.rooms,
        playbackSessions: dependencies.playbackSessions,
        queueEntries: dependencies.queueEntries,
        ...(dependencies.playableMedia ? { playableMedia: dependencies.playableMedia } : {}),
        pairingTokens: dependencies.pairingTokens,
        controlSessions: dependencies.controlSessions,
        deviceSessions: dependencies.deviceSessions,
        playbackEvents: dependencies.playbackEvents
      },
      ...(dependencies.mediaGateway ? { mediaGateway: dependencies.mediaGateway } : {})
    });

    if (snapshot) {
      return toRoomStatusResponse(room, snapshot);
    }

    return toRoomStatusResponse(room, await buildFallbackRoomStatus(request.params.roomSlug, room, dependencies));
  });

  server.post<{ Params: { roomSlug: string } }>("/admin/rooms/:roomSlug/pairing-token/refresh", async (request, reply) => {
    const room = await dependencies.rooms.findBySlug(request.params.roomSlug);
    if (!room) {
      return reply.code(404).send({ error: "ROOM_NOT_FOUND" });
    }

    const pairing = await refreshPairingToken({
      room,
      publicBaseUrl: dependencies.config.publicBaseUrl,
      repository: dependencies.pairingTokens,
      ...(dependencies.config.controllerBaseUrl ? { controllerBaseUrl: dependencies.config.controllerBaseUrl } : {})
    });

    return { pairing };
  });

}

async function buildFallbackRoomStatus(
  roomSlug: string,
  room: NonNullable<Awaited<ReturnType<RoomRepository["findBySlug"]>>>,
  dependencies: AdminRoomsRouteDependencies
): Promise<any> {
  const now = new Date();
  const [pairing, session, effectiveQueue, removedQueue, onlineCount, recentEvents, activeTvPlayers] = await Promise.all([
    getOrCreatePairingInfo({
      room,
      publicBaseUrl: dependencies.config.publicBaseUrl,
      repository: dependencies.pairingTokens,
      now,
      ...(dependencies.config.controllerBaseUrl ? { controllerBaseUrl: dependencies.config.controllerBaseUrl } : {})
    }),
    dependencies.playbackSessions.findByRoomId(room.id),
    dependencies.queueEntries.listEffectiveQueue(room.id),
    dependencies.queueEntries.listUndoableRemoved(room.id, now),
    dependencies.controlSessions.countActiveByRoom(room.id, new Date(now.getTime() - 60 * 1000)),
    typeof dependencies.playbackEvents?.listRecentByRoom === "function"
      ? dependencies.playbackEvents.listRecentByRoom(room.id, 20)
      : Promise.resolve([]),
    dependencies.deviceSessions.listActiveTvPlayers(room.id, new Date(now.getTime() - 30_000))
  ]);
  const primaryTv = activeTvPlayers[0] ?? null;

  const currentQueueEntry = session?.currentQueueEntryId ? await dependencies.queueEntries.findById(session.currentQueueEntryId) : null;
  const currentMedia = currentQueueEntry
    ? await dependencies.playableMedia?.findPlayableBySource(sourceRefFromQueueEntry(currentQueueEntry))
    : null;
  const queue = await buildQueuePreview({
    currentQueueEntryId: currentQueueEntry?.id ?? null,
    queue: [...effectiveQueue, ...removedQueue],
    ...(dependencies.playableMedia ? { playableMedia: dependencies.playableMedia } : {})
  });

  return {
    type: "room.control.snapshot",
    roomId: room.id,
    roomSlug,
    sessionVersion: session?.version ?? 0,
    state: currentQueueEntry && currentMedia?.status === "ready" ? "playing" : room.status === "active" ? "idle" : "error",
    pairing,
    tvPresence: {
      online: activeTvPlayers.length > 0,
      deviceName: primaryTv?.deviceName ?? null,
      lastSeenAt: primaryTv?.lastSeenAt ?? null,
      onlineCount: activeTvPlayers.length,
      devices: activeTvPlayers
        .filter((device) => device.lastSeenAt)
        .map((device) => ({
          deviceId: device.id,
          deviceName: device.deviceName,
          lastSeenAt: device.lastSeenAt ?? now.toISOString()
        })),
      conflict: null
    },
    controllers: { onlineCount },
    currentTarget:
      currentQueueEntry && currentMedia?.status === "ready" && dependencies.mediaGateway
        ? {
            roomId: room.id,
            sessionVersion: session?.version ?? 0,
            queueEntryId: currentQueueEntry.id,
            sourceType: currentMedia.sourceType,
            songId: currentMedia.songId,
            assetId: currentMedia.assetId,
            currentQueueEntryPreview: {
              queueEntryId: currentQueueEntry.id,
              songTitle: currentMedia.title,
              artistName: currentMedia.artistName
            },
            playbackUrl: dependencies.mediaGateway.createPlaybackUrl(sourceRefFromQueueEntry(currentQueueEntry)),
            resumePositionMs: session?.playerPositionMs ?? 0,
            vocalMode: session?.targetVocalMode ?? "instrumental",
            switchFamily: null,
            playbackProfile: currentMedia.playbackProfile,
            selectedTrackRef: null,
            nextQueueEntryPreview: null
          }
        : null,
    switchTarget: null,
    queue,
    recentEvents,
    onlineTasks: buildEmptyOnlineTaskSummary(),
    notice: null,
    generatedAt: now.toISOString()
  };
}

function toRoomStatusResponse(
  room: NonNullable<Awaited<ReturnType<RoomRepository["findBySlug"]>>>,
  snapshot: Awaited<ReturnType<typeof buildFallbackRoomStatus>>
) {
  return {
    room: { roomId: room.id, roomSlug: room.slug, status: room.status },
    pairing: {
      tokenExpiresAt: snapshot.pairing.tokenExpiresAt,
      controllerUrl: snapshot.pairing.controllerUrl,
      qrPayload: snapshot.pairing.qrPayload
    },
    tvPresence: snapshot.tvPresence,
    controllers: snapshot.controllers,
    sessionVersion: snapshot.sessionVersion,
    current: snapshot.currentTarget
      ? {
          queueEntryId: snapshot.currentTarget.queueEntryId,
          songTitle: snapshot.currentTarget.currentQueueEntryPreview.songTitle,
          artistName: snapshot.currentTarget.currentQueueEntryPreview.artistName,
          vocalMode: snapshot.currentTarget.vocalMode
        }
      : null,
    queue: snapshot.queue,
    recentEvents: snapshot.recentEvents ?? [],
    onlineTasks: snapshot.onlineTasks ?? buildEmptyOnlineTaskSummary()
  };
}

async function buildQueuePreview(input: {
  currentQueueEntryId: string | null;
  queue: readonly { id: string; songId: string; assetId: string; source?: MediaSourceRef; requestedBy: string; queuePosition: number; status: string; undoExpiresAt: string | null; removedAt: string | null; }[];
  playableMedia?: PlayableMediaRepository;
}) {
  const previews: Array<{
    queueEntryId: string;
    sourceType: string;
    songId: string;
    assetId: string;
    songTitle: string;
    artistName: string;
    requestedBy: string;
    queuePosition: number;
    status: QueueEntryStatus;
    canPromote: boolean;
    canDelete: boolean;
    undoExpiresAt: string | null;
  }> = [];
  for (const entry of input.queue) {
    const media = await input.playableMedia?.findPlayableBySource(sourceRefFromQueueEntry(entry));
    if (!media) {
      continue;
    }

    previews.push({
      queueEntryId: entry.id,
      sourceType: media.sourceType,
      songId: media.songId,
      assetId: media.assetId,
      songTitle: media.title,
      artistName: media.artistName,
      requestedBy: entry.requestedBy,
      queuePosition: entry.queuePosition,
      status: entry.status as QueueEntryStatus,
      canPromote: entry.status === "queued" && entry.id !== input.currentQueueEntryId,
      canDelete: entry.status === "queued" && entry.id !== input.currentQueueEntryId,
      undoExpiresAt: entry.undoExpiresAt
    });
  }

  return previews;
}

function sourceRefFromQueueEntry(entry: { songId: string; assetId: string; source?: MediaSourceRef }): MediaSourceRef {
  return entry.source ?? {
    sourceType: "nas",
    songId: entry.songId,
    assetId: entry.assetId
  };
}
