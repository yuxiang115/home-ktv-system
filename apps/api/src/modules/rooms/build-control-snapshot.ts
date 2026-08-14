import type { ApiConfig } from "../../config.js";
import type { RoomRepository } from "./repositories/room-repository.js";
import type { PlaybackSessionRepository } from "../playback/repositories/playback-session-repository.js";
import type { QueueEntryRepository } from "../playback/repositories/queue-entry-repository.js";
import type { MediaGateway } from "../media/media-gateway.js";
import type { PlayableMediaRepository } from "../media/playable-media-repository.js";
import type { RoomPairingTokenRepository } from "./repositories/pairing-token-repository.js";
import type { ControlSessionRepository } from "../controller/repositories/control-session-repository.js";
import type { PlayerDeviceSessionRepository } from "../player/register-player.js";
import { buildRoomSnapshot } from "../../routes/room-snapshots.js";
import {
  summarizeSupplementTasks,
  type OnlineSupplementTaskRepository
} from "../online-supplement/supplement-task-repository.js";
import type {
  OnlineSupplementTaskSummary,
  PlaybackEvent,
  QueueEntry,
  RoomId,
  RoomOnlineSupplementTaskSummary
} from "@home-ktv/domain";
import {
  DEFAULT_ROOM_VOLUME_PERCENT,
  type PlaybackNotice,
  type RoomControlSnapshot,
  type RoomQueueEntryPreview
} from "@home-ktv/player-contracts";

const ACTIVE_TV_PLAYER_WINDOW_MS = 30_000;

interface RecentPlaybackEventRepository {
  append?: unknown;
  listRecentByRoom?: (roomId: RoomId, limit?: number) => Promise<PlaybackEvent[]>;
}

export interface RoomRecentPlaybackEvent {
  id: string;
  roomId: string;
  queueEntryId: string | null;
  eventType: string;
  eventPayload: Record<string, unknown>;
  createdAt: string;
}

export interface RoomControlRecoverySnapshot extends RoomControlSnapshot {
  recentEvents: RoomRecentPlaybackEvent[];
  onlineTasks: RoomOnlineSupplementTaskSummary;
}

export interface ControlSnapshotRepositories {
  rooms: RoomRepository;
  playbackSessions: PlaybackSessionRepository;
  queueEntries: QueueEntryRepository;
  playableMedia?: PlayableMediaRepository;
  pairingTokens: RoomPairingTokenRepository;
  controlSessions: ControlSessionRepository;
  deviceSessions: PlayerDeviceSessionRepository;
  playbackEvents?: RecentPlaybackEventRepository | undefined;
  supplementTasks?: Pick<OnlineSupplementTaskRepository, "listRecentByRoom">;
}

export interface BuildRoomControlSnapshotInput {
  roomSlug: string;
  config: ApiConfig;
  repositories: ControlSnapshotRepositories;
  mediaGateway?: Pick<MediaGateway, "createPlaybackUrl">;
  notice?: PlaybackNotice | null;
  now?: Date;
}

export async function buildRoomControlSnapshot(input: BuildRoomControlSnapshotInput): Promise<RoomControlRecoverySnapshot | null> {
  const now = input.now ?? new Date();
  const baseSnapshotInput = {
    roomSlug: input.roomSlug,
    config: input.config,
    repositories: input.repositories,
    ...(input.mediaGateway ? { mediaGateway: input.mediaGateway } : {}),
    now
  };
  const baseSnapshot = await buildRoomSnapshot({
    ...baseSnapshotInput,
    ...(input.notice !== undefined ? { notice: input.notice } : {})
  });
  if (!baseSnapshot) {
    return null;
  }

  const room = await input.repositories.rooms.findBySlug(input.roomSlug);
  if (!room) {
    return null;
  }

  const [session, queue, removedQueue, recentEvents, recentSupplementTasks] = await Promise.all([
    input.repositories.playbackSessions.findByRoomId(room.id),
    input.repositories.queueEntries.listEffectiveQueue(room.id),
    input.repositories.queueEntries.listUndoableRemoved(room.id, now),
    listRecentPlaybackEvents(input.repositories, room.id),
    listRecentSupplementTasks(input.repositories, room.id)
  ]);
  const activeTvPlayers = await input.repositories.deviceSessions.listActiveTvPlayers(
    room.id,
    new Date(now.getTime() - ACTIVE_TV_PLAYER_WINDOW_MS)
  );
  const activeTvPlayer = activeTvPlayers[0] ?? null;

  const onlineCount = await input.repositories.controlSessions.countActiveByRoom(
    room.id,
    new Date(now.getTime() - 60 * 1000)
  );
  const queuePreview = await buildQueuePreview({
    currentQueueEntryId: session?.currentQueueEntryId ?? null,
    queue: [...queue, ...removedQueue],
    repositories: input.repositories,
    removedQueueIds: new Set(removedQueue.map((entry) => entry.id))
  });
  return {
    type: "room.control.snapshot",
    roomId: baseSnapshot.roomId,
    roomSlug: baseSnapshot.roomSlug,
    sessionVersion: session?.version ?? baseSnapshot.sessionVersion,
    state: baseSnapshot.state,
    volumePercent: baseSnapshot.volumePercent ?? DEFAULT_ROOM_VOLUME_PERCENT,
    pairing: baseSnapshot.pairing,
    tvPresence: activeTvPlayer
      ? {
          online: true,
          deviceName: activeTvPlayer.deviceName,
          lastSeenAt: activeTvPlayer.lastSeenAt,
          onlineCount: activeTvPlayers.length,
          devices: activeTvPlayers
            .filter((device) => device.lastSeenAt)
            .map((device) => ({
              deviceId: device.id,
              deviceName: device.deviceName,
              lastSeenAt: device.lastSeenAt ?? now.toISOString()
            })),
          conflict: null
        }
      : { online: false, deviceName: null, lastSeenAt: null, onlineCount: 0, devices: [], conflict: null },
    controllers: { onlineCount },
    currentTarget: baseSnapshot.currentTarget,
    switchTarget: baseSnapshot.switchTarget,
    targetVocalMode: baseSnapshot.targetVocalMode ?? null,
    queue: queuePreview,
    recentEvents: recentEvents.map(playbackEventPreview),
    onlineTasks: summarizeSupplementTasks(recentSupplementTasks),
    notice: baseSnapshot.notice,
    generatedAt: baseSnapshot.generatedAt
  };
}

export function buildEmptyOnlineTaskSummary(): RoomOnlineSupplementTaskSummary {
  return { counts: { total: 0 }, tasks: [] };
}

async function buildQueuePreview(input: {
  currentQueueEntryId: string | null;
  queue: readonly QueueEntry[];
  repositories: ControlSnapshotRepositories;
  removedQueueIds: Set<string>;
}): Promise<RoomQueueEntryPreview[]> {
  const previews: RoomQueueEntryPreview[] = [];

  for (const queueEntry of input.queue) {
    const playableMedia = await input.repositories.playableMedia?.findPlayableBySource({
      sourceType: queueEntry.source?.sourceType ?? "nas",
      assetId: queueEntry.source?.assetId ?? queueEntry.assetId
    });
    if (playableMedia) {
      previews.push(
        queueEntryPreviewFromPlayableMedia(
          queueEntry,
          playableMedia,
          input.currentQueueEntryId,
          input.removedQueueIds.has(queueEntry.id)
        )
      );
      continue;
    }

  }

  return previews;
}

function queueEntryPreviewFromPlayableMedia(
  queueEntry: QueueEntry,
  playableMedia: { title: string; artistName: string },
  currentQueueEntryId: string | null,
  removed: boolean
): RoomQueueEntryPreview {
  const isCurrent = currentQueueEntryId === queueEntry.id;
  const canDelete = !removed && !isCurrent && queueEntry.status === "queued";
  const canPromote = !removed && !isCurrent && (queueEntry.status === "queued" || queueEntry.status === "preparing" || queueEntry.status === "loading");

  return {
    queueEntryId: queueEntry.id,
    sourceType: queueEntry.source?.sourceType ?? "nas",
    songId: queueEntry.source?.songId ?? queueEntry.songId,
    assetId: queueEntry.source?.assetId ?? queueEntry.assetId,
    songTitle: playableMedia.title,
    artistName: playableMedia.artistName,
    requestedBy: queueEntry.requestedBy,
    requestedByUserPhone: queueEntry.requestedByUserPhone ?? null,
    requestedByName: queueEntry.requestedByName ?? null,
    queuePosition: queueEntry.queuePosition,
    status: removed ? "removed" : queueEntry.status,
    canPromote: removed ? false : canPromote,
    canDelete: removed ? false : canDelete,
    undoExpiresAt: removed ? queueEntry.undoExpiresAt : null
  };
}

function playbackEventPreview(event: PlaybackEvent): RoomRecentPlaybackEvent {
  return {
    id: event.id,
    roomId: event.roomId,
    queueEntryId: event.queueEntryId,
    eventType: event.eventType,
    eventPayload: event.eventPayload,
    createdAt: event.createdAt
  };
}

function listRecentPlaybackEvents(
  repositories: ControlSnapshotRepositories,
  roomId: string
): Promise<PlaybackEvent[]> {
  if (typeof repositories.playbackEvents?.listRecentByRoom !== "function") {
    return Promise.resolve([]);
  }
  return repositories.playbackEvents.listRecentByRoom(roomId, 20);
}

function listRecentSupplementTasks(
  repositories: ControlSnapshotRepositories,
  roomId: string
): Promise<OnlineSupplementTaskSummary[]> {
  if (typeof repositories.supplementTasks?.listRecentByRoom !== "function") {
    return Promise.resolve([]);
  }
  return repositories.supplementTasks.listRecentByRoom(roomId, 20);
}
