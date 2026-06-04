import { describe, expect, it } from "vitest";
import type { PlaybackSession, QueueEntry, Room } from "@home-ktv/domain";
import { DEFAULT_ROOM_VOLUME_PERCENT } from "@home-ktv/player-contracts";
import { normalizeApiConfig, type ApiConfig } from "../config.js";
import type { PlayableMediaAsset, PlayableMediaLookup, PlayableMediaRepository } from "../modules/media/playable-media-repository.js";
import { InMemoryPlaybackEventRepository } from "../modules/playback/repositories/playback-event-repository.js";
import { InMemoryQueueEntryRepository } from "../modules/playback/repositories/queue-entry-repository.js";
import type { PlaybackSessionRepository } from "../modules/playback/repositories/playback-session-repository.js";
import type { RoomSessionCommandRepository, RoomSessionCommandRecord } from "../modules/playback/repositories/room-session-command-repository.js";
import { InMemoryControlSessionRepository } from "../modules/controller/repositories/control-session-repository.js";
import type { PlayerDeviceSessionRepository } from "../modules/player/register-player.js";
import { InMemoryRoomPairingTokenRepository } from "../modules/rooms/repositories/pairing-token-repository.js";
import type { RoomRepository } from "../modules/rooms/repositories/room-repository.js";
import { handlePlayerEnded, handlePlayerFailed } from "../modules/playback/session-command-service.js";

const now = new Date("2026-06-04T12:00:00.000Z");

describe("player telemetry queue advancement", () => {
  it("ignores ended telemetry that no longer matches the current playback item", async () => {
    const harness = createHarness();

    const result = await handlePlayerEnded({
      roomSlug: "living-room",
      deviceId: "android-tv",
      queueEntryId: "queue-old",
      assetId: "asset-old",
      playbackPositionMs: 120_000,
      sessionVersion: 1,
      playbackEvents: harness.playbackEvents,
      repositories: harness.repositories,
      config: createConfig(),
      now
    });

    expect(result.status).toBe("rejected");
    expect(result.sessionVersion).toBe(8);
    expect((await harness.queueEntries.findById("queue-current"))?.status).toBe("playing");
    expect((await harness.queueEntries.findById("queue-next"))?.status).toBe("queued");
    expect(harness.playbackSessions.currentQueueEntryId).toBe("queue-current");
  });

  it("ignores failed telemetry that no longer matches the current playback item", async () => {
    const harness = createHarness();

    const result = await handlePlayerFailed({
      roomSlug: "living-room",
      deviceId: "android-tv",
      queueEntryId: "queue-old",
      assetId: "asset-old",
      playbackPositionMs: 1_000,
      sessionVersion: 1,
      playbackEvents: harness.playbackEvents,
      repositories: harness.repositories,
      config: createConfig(),
      failureCause: "stale-libvlc-event",
      now
    });

    expect(result.status).toBe("rejected");
    expect(result.fallbackResult).toBe("skipped_to_idle");
    expect((await harness.queueEntries.findById("queue-current"))?.status).toBe("playing");
    expect((await harness.queueEntries.findById("queue-next"))?.status).toBe("queued");
    expect(harness.playbackSessions.currentQueueEntryId).toBe("queue-current");
  });

  it("ignores failed telemetry from a non-owner TV in the same room", async () => {
    const harness = createHarness({ defaultPlayerDeviceId: "android-tv" });

    const result = await handlePlayerFailed({
      roomSlug: "living-room",
      deviceId: "web-tv",
      queueEntryId: "queue-current",
      assetId: "asset-current",
      playbackPositionMs: 49_000,
      sessionVersion: 8,
      playbackEvents: harness.playbackEvents,
      repositories: harness.repositories,
      config: createConfig(),
      failureCause: "TV_PLAYBACK_CAPABILITY_BLOCKED",
      now
    });

    expect(result.status).toBe("rejected");
    expect(result.rejectReason).toBe("player_device_not_owner");
    expect((await harness.queueEntries.findById("queue-current"))?.status).toBe("playing");
    expect((await harness.queueEntries.findById("queue-next"))?.status).toBe("queued");
    expect(harness.playbackSessions.currentQueueEntryId).toBe("queue-current");
  });

  it("ignores ended telemetry from a non-owner TV in the same room", async () => {
    const harness = createHarness({ defaultPlayerDeviceId: "android-tv" });

    const result = await handlePlayerEnded({
      roomSlug: "living-room",
      deviceId: "web-tv",
      queueEntryId: "queue-current",
      assetId: "asset-current",
      playbackPositionMs: 180_000,
      sessionVersion: 8,
      playbackEvents: harness.playbackEvents,
      repositories: harness.repositories,
      config: createConfig(),
      now
    });

    expect(result.status).toBe("rejected");
    expect(result.rejectReason).toBe("player_device_not_owner");
    expect((await harness.queueEntries.findById("queue-current"))?.status).toBe("playing");
    expect((await harness.queueEntries.findById("queue-next"))?.status).toBe("queued");
    expect(harness.playbackSessions.currentQueueEntryId).toBe("queue-current");
  });
});

function createHarness(input: { defaultPlayerDeviceId?: string | null } = {}) {
  const room = createRoom(input.defaultPlayerDeviceId ?? null);
  const queueEntries = new InMemoryQueueEntryRepository([
    createQueueEntry("queue-current", "asset-current", "playing", 1),
    createQueueEntry("queue-next", "asset-next", "queued", 2)
  ]);
  const playbackSessions = new FakePlaybackSessionRepository({
    roomId: room.id,
    currentQueueEntryId: "queue-current",
    nextQueueEntryId: "queue-next",
    activeAssetId: "asset-current",
    targetVocalMode: "instrumental",
    playerState: "playing",
    playerPositionMs: 45_000,
    volumePercent: DEFAULT_ROOM_VOLUME_PERCENT,
    mediaStartedAt: now.toISOString(),
    version: 8,
    updatedAt: now.toISOString()
  });
  const playbackEvents = new InMemoryPlaybackEventRepository();

  return {
    queueEntries,
    playbackSessions,
    playbackEvents,
    repositories: {
      rooms: new FakeRoomRepository(room),
      playbackSessions,
      queueEntries,
      playableMedia: new FakePlayableMediaRepository(),
      pairingTokens: new InMemoryRoomPairingTokenRepository(),
      controlSessions: new InMemoryControlSessionRepository(),
      controlCommands: new FakeRoomSessionCommandRepository(),
      deviceSessions: new FakeDeviceSessionRepository()
    }
  };
}

class FakeRoomRepository implements RoomRepository {
  constructor(private readonly room: Room) {}

  async findById(roomId: string): Promise<Room | null> {
    return roomId === this.room.id ? { ...this.room } : null;
  }

  async findBySlug(slug: string): Promise<Room | null> {
    return slug === this.room.slug ? { ...this.room } : null;
  }
}

class FakePlaybackSessionRepository implements PlaybackSessionRepository {
  constructor(private session: PlaybackSession) {}

  get currentQueueEntryId(): string | null {
    return this.session.currentQueueEntryId;
  }

  async findByRoomId(roomId: string): Promise<PlaybackSession | null> {
    return roomId === this.session.roomId ? { ...this.session } : null;
  }

  async startQueueEntry(input: Parameters<PlaybackSessionRepository["startQueueEntry"]>[0]): Promise<PlaybackSession | null> {
    this.session = {
      ...this.session,
      currentQueueEntryId: input.queueEntryId,
      nextQueueEntryId: input.nextQueueEntryId ?? null,
      activeAssetId: input.activeAssetId ?? null,
      targetVocalMode: input.targetVocalMode ?? this.session.targetVocalMode,
      playerState: input.playerState ?? "loading",
      playerPositionMs: input.playerPositionMs ?? 0,
      mediaStartedAt: input.mediaStartedAt?.toISOString() ?? null,
      version: this.session.version + 1,
      updatedAt: now.toISOString()
    };
    return { ...this.session };
  }

  async setIdle(): Promise<PlaybackSession | null> {
    this.session = {
      ...this.session,
      currentQueueEntryId: null,
      nextQueueEntryId: null,
      playerState: "idle",
      playerPositionMs: 0,
      mediaStartedAt: null,
      version: this.session.version + 1,
      updatedAt: now.toISOString()
    };
    return { ...this.session };
  }

  async requestSwitchTarget(): Promise<PlaybackSession | null> {
    return { ...this.session };
  }
}

class FakePlayableMediaRepository implements PlayableMediaRepository {
  async findPlayableBySource(source: PlayableMediaLookup): Promise<PlayableMediaAsset | null> {
    return {
      sourceType: source.sourceType,
      songId: `song-${source.assetId}`,
      assetId: source.assetId,
      title: "Song",
      artistName: "Artist",
      displayName: "Artist - Song",
      filePath: `/nas/${source.assetId}.mkv`,
      status: "ready",
      durationMs: 180_000,
      compatibilityStatus: "playable",
      compatibilityReasons: [],
      mediaInfoSummary: {
        container: "matroska,webm",
        durationMs: 180_000,
        videoCodec: "h264",
        resolution: null,
        fileSizeBytes: 1_000,
        audioTracks: []
      },
      mediaInfoProvenance: {
        source: "ffprobe",
        sourceVersion: null,
        probedAt: now.toISOString(),
        importedFrom: `/nas/${source.assetId}.mkv`
      },
      trackRoles: { original: null, instrumental: null },
      playbackProfile: {
        kind: "single_file_audio_tracks",
        container: "matroska,webm",
        videoCodec: "h264",
        audioCodecs: [],
        requiresAudioTrackSelection: false
      }
    };
  }
}

class FakeRoomSessionCommandRepository implements RoomSessionCommandRepository {
  async findCommand(): Promise<RoomSessionCommandRecord | null> {
    return null;
  }

  async insertCommandAttempt(input: Parameters<RoomSessionCommandRepository["insertCommandAttempt"]>[0]): Promise<RoomSessionCommandRecord> {
    return {
      commandId: input.commandId,
      roomId: input.roomId,
      controlSessionId: input.controlSessionId,
      sessionVersion: input.sessionVersion,
      type: input.type,
      payload: input.payload,
      resultStatus: input.resultStatus,
      resultPayload: input.resultPayload ?? {},
      createdAt: now.toISOString()
    };
  }

  async updateCommandResult(): Promise<RoomSessionCommandRecord | null> {
    return null;
  }
}

class FakeDeviceSessionRepository implements PlayerDeviceSessionRepository {
  async findActiveTvPlayer(): Promise<null> {
    return null;
  }

  async listActiveTvPlayers(): Promise<[]> {
    return [];
  }

  async upsertTvPlayer(): Promise<never> {
    throw new Error("Not implemented");
  }

  async updateTvHeartbeat(): Promise<null> {
    return null;
  }
}

function createRoom(defaultPlayerDeviceId: string | null = null): Room {
  return {
    id: "room-1",
    slug: "living-room",
    name: "Living Room",
    status: "active",
    defaultPlayerDeviceId,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
}

function createQueueEntry(id: string, assetId: string, status: QueueEntry["status"], queuePosition: number): QueueEntry {
  return {
    id,
    roomId: "room-1",
    source: { sourceType: "nas", songId: `song-${assetId}`, assetId },
    songId: `song-${assetId}`,
    assetId,
    requestedBy: "phone",
    queuePosition,
    status,
    priority: 0,
    playbackOptions: {
      preferredVocalMode: null,
      pitchSemitones: 0,
      requireReadyAsset: true
    },
    requestedAt: now.toISOString(),
    startedAt: status === "playing" ? now.toISOString() : null,
    endedAt: null,
    removedAt: null,
    removedByControlSessionId: null,
    undoExpiresAt: null
  };
}

function createConfig(): ApiConfig {
  return normalizeApiConfig({
    roomSlug: "living-room",
    publicBaseUrl: "http://ktv.local",
    controllerBaseUrl: "http://controller.local",
    corsAllowedOrigins: [],
    port: 4000,
    host: "127.0.0.1",
    databaseUrl: "postgres://ktv:ktv@localhost/home_ktv",
    mediaRoot: "/tmp/home-ktv-media",
    mediaPathMappings: []
  });
}
