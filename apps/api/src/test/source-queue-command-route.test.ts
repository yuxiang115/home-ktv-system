import Fastify from "fastify";
import type { ControlSession, PlaybackSession, QueueEntry, Room } from "@home-ktv/domain";
import { DEFAULT_ROOM_VOLUME_PERCENT } from "@home-ktv/player-contracts";
import { describe, expect, it } from "vitest";
import type { ApiConfig } from "../config.js";
import { InMemoryControlSessionRepository } from "../modules/controller/repositories/control-session-repository.js";
import type { MediaGateway } from "../modules/media/media-gateway.js";
import type { PlayableMediaAsset, PlayableMediaLookup, PlayableMediaRepository } from "../modules/media/playable-media-repository.js";
import type { PlayerDeviceSessionRepository } from "../modules/player/register-player.js";
import { InMemoryQueueEntryRepository } from "../modules/playback/repositories/queue-entry-repository.js";
import type { PlaybackSessionRepository } from "../modules/playback/repositories/playback-session-repository.js";
import type { RoomSessionCommandRecord, RoomSessionCommandRepository } from "../modules/playback/repositories/room-session-command-repository.js";
import { InMemoryRoomPairingTokenRepository } from "../modules/rooms/repositories/pairing-token-repository.js";
import type { RoomRepository } from "../modules/rooms/repositories/room-repository.js";
import { registerControlCommandRoutes } from "../routes/control-commands.js";

const now = new Date("2026-05-28T10:00:00.000Z");

describe("source-aware queue command route", () => {
  it("queues NAS songs by source asset and returns a NAS snapshot", async () => {
    const playableAsset = createPlayableMediaAsset();
    const server = await createControlCommandServer({ playableMedia: [playableAsset] });

    const response = await server.inject({
      method: "POST",
      url: "/rooms/living-room/commands/add-queue-entry",
      headers: { cookie: "ktv_control_session=control-session-1" },
      payload: {
        commandId: "command-add-nas-route",
        sessionVersion: 1,
        deviceId: "phone-1",
        sourceType: "nas",
        assetId: playableAsset.assetId
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "accepted",
      commandId: "command-add-nas-route",
      sessionVersion: 2,
      snapshot: {
        currentTarget: {
          sourceType: "nas",
          songId: playableAsset.songId,
          assetId: playableAsset.assetId,
          playbackUrl: `http://ktv.local/media/nas/${playableAsset.assetId}`
        },
        queue: [
          {
            sourceType: "nas",
            songId: playableAsset.songId,
            assetId: playableAsset.assetId,
            songTitle: playableAsset.title,
            artistName: playableAsset.artistName,
            status: "loading"
          }
        ]
      }
    });

    await server.close();
  });

  it("rejects retired indexed queue payloads instead of syncing them", async () => {
    const server = await createControlCommandServer({ playableMedia: [createPlayableMediaAsset()] });

    const response = await server.inject({
      method: "POST",
      url: "/rooms/living-room/commands/add-queue-entry",
      headers: { cookie: "ktv_control_session=control-session-1" },
      payload: {
        commandId: "command-indexed-retired",
        sessionVersion: 1,
        deviceId: "phone-1",
        indexedAssetId: "ktv-asset-1"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: "INVALID_QUEUE_SOURCE", message: "点歌来源无效" });
    await server.close();
  });

  it("rejects online queue payloads until online playback is implemented", async () => {
    const server = await createControlCommandServer({ playableMedia: [createPlayableMediaAsset()] });

    const response = await server.inject({
      method: "POST",
      url: "/rooms/living-room/commands/add-queue-entry",
      headers: { cookie: "ktv_control_session=control-session-1" },
      payload: {
        commandId: "command-online-not-ready",
        sessionVersion: 1,
        deviceId: "phone-1",
        sourceType: "online",
        assetId: "online-asset-1"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: "ONLINE_PLAYBACK_NOT_IMPLEMENTED", message: null });
    await server.close();
  });
});

async function createControlCommandServer(input: { playableMedia: readonly PlayableMediaAsset[] }) {
  const room = createRoom();
  const queueEntries = new InMemoryQueueEntryRepository();
  const playableMedia = new FakePlayableMediaRepository(input.playableMedia);
  const server = Fastify();
  const mediaGateway: Pick<MediaGateway, "createPlaybackUrl"> = {
    createPlaybackUrl(source: PlayableMediaLookup) {
      return `http://ktv.local/media/${source.sourceType}/${source.assetId}`;
    }
  };

  await registerControlCommandRoutes(server, {
    config: createConfig(),
    repositories: {
      rooms: new FakeRoomRepository(room),
      playbackSessions: new FakePlaybackSessionRepository(room.id),
      queueEntries,
      playableMedia,
      pairingTokens: new InMemoryRoomPairingTokenRepository(),
      controlSessions: new InMemoryControlSessionRepository([createControlSession(room.id)]),
      controlCommands: new FakeRoomSessionCommandRepository(),
      deviceSessions: new FakeDeviceSessionRepository()
    },
    mediaGateway
  });

  await server.ready();
  return server;
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
  private session: PlaybackSession;

  constructor(roomId: string) {
    this.session = {
      roomId,
      currentQueueEntryId: null,
      nextQueueEntryId: null,
      activeAssetId: null,
      targetVocalMode: "instrumental",
      playerState: "idle",
      playerPositionMs: 0,
      volumePercent: DEFAULT_ROOM_VOLUME_PERCENT,
      mediaStartedAt: null,
      version: 1,
      updatedAt: now.toISOString()
    };
  }

  async findByRoomId(roomId: string): Promise<PlaybackSession | null> {
    return roomId === this.session.roomId ? { ...this.session } : null;
  }

  async startQueueEntry(input: Parameters<PlaybackSessionRepository["startQueueEntry"]>[0]): Promise<PlaybackSession | null> {
    if (input.roomId !== this.session.roomId) {
      return null;
    }

    this.session = {
      ...this.session,
      currentQueueEntryId: input.queueEntryId,
      activeAssetId: input.activeAssetId ?? null,
      targetVocalMode: input.targetVocalMode ?? this.session.targetVocalMode,
      playerState: input.playerState ?? "loading",
      playerPositionMs: input.playerPositionMs ?? 0,
      nextQueueEntryId: input.nextQueueEntryId ?? null,
      mediaStartedAt: input.mediaStartedAt?.toISOString() ?? null,
      version: this.session.version + 1,
      updatedAt: now.toISOString()
    };
    return { ...this.session };
  }

  async setIdle(): Promise<PlaybackSession | null> {
    return null;
  }

  async requestSwitchTarget(): Promise<PlaybackSession | null> {
    return null;
  }
}

class FakePlayableMediaRepository implements PlayableMediaRepository {
  constructor(private readonly assets: readonly PlayableMediaAsset[]) {}

  async findPlayableBySource(source: PlayableMediaLookup): Promise<PlayableMediaAsset | null> {
    return this.assets.find((asset) => asset.sourceType === source.sourceType && asset.assetId === source.assetId) ?? null;
  }
}

class FakeRoomSessionCommandRepository implements RoomSessionCommandRepository {
  private readonly records = new Map<string, RoomSessionCommandRecord>();

  async findCommand(commandId: string): Promise<RoomSessionCommandRecord | null> {
    return this.records.get(commandId) ?? null;
  }

  async insertCommandAttempt(input: Parameters<RoomSessionCommandRepository["insertCommandAttempt"]>[0]): Promise<RoomSessionCommandRecord> {
    const record: RoomSessionCommandRecord = {
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
    this.records.set(input.commandId, record);
    return record;
  }

  async updateCommandResult(input: Parameters<RoomSessionCommandRepository["updateCommandResult"]>[0]): Promise<RoomSessionCommandRecord | null> {
    const existing = this.records.get(input.commandId);
    if (!existing) {
      return null;
    }

    const updated: RoomSessionCommandRecord = {
      ...existing,
      resultStatus: input.resultStatus,
      resultPayload: input.resultPayload ?? {}
    };
    this.records.set(input.commandId, updated);
    return updated;
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

  async updateTvHeartbeat(): Promise<never> {
    throw new Error("Not implemented");
  }
}

function createRoom(): Room {
  return {
    id: "living-room",
    slug: "living-room",
    name: "Living Room",
    status: "active",
    defaultPlayerDeviceId: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
}

function createConfig(): ApiConfig {
  return {
    corsAllowedOrigins: [],
    databaseUrl: "",
    mediaPathMappings: [],
    mediaRoot: "/media-root",
    onlineDemoReadyAssetId: "",
    onlineProviderIds: [],
    onlineProviderKillSwitchIds: [],
    publicBaseUrl: "http://ktv.local",
    roomSlug: "living-room",
    port: 4000,
    host: "0.0.0.0",
    scanIntervalMinutes: 360
  };
}

function createControlSession(roomId: string): ControlSession {
  return {
    id: "control-session-1",
    roomId,
    deviceId: "phone-1",
    deviceName: "Phone",
    lastSeenAt: now.toISOString(),
    expiresAt: "2099-01-01T00:00:00.000Z",
    revokedAt: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
}

function createPlayableMediaAsset(overrides: Partial<PlayableMediaAsset> = {}): PlayableMediaAsset {
  return {
    sourceType: "nas",
    songId: "ktv-song-1",
    assetId: "ktv-asset-1",
    title: "晴天",
    artistName: "周杰伦",
    displayName: "晴天.mkv",
    filePath: "/nas/晴天.mkv",
    status: "ready",
    durationMs: 180000,
    compatibilityStatus: "playable",
    compatibilityReasons: [],
    mediaInfoSummary: {
      container: "matroska,webm",
      durationMs: 180000,
      videoCodec: "h264",
      resolution: null,
      fileSizeBytes: 100,
      audioTracks: [
        { index: 0, id: "0x1100", label: "Original", language: null, codec: "aac", channels: 2 },
        { index: 1, id: "0x1101", label: "Instrumental", language: null, codec: "aac", channels: 2 }
      ]
    },
    mediaInfoProvenance: {
      source: "ffprobe",
      sourceVersion: null,
      probedAt: null,
      importedFrom: null
    },
    trackRoles: {
      original: { index: 0, id: "0x1100", label: "Original" },
      instrumental: { index: 1, id: "0x1101", label: "Instrumental" }
    },
    playbackProfile: {
      kind: "single_file_audio_tracks",
      container: "matroska,webm",
      videoCodec: "h264",
      audioCodecs: ["aac"],
      requiresAudioTrackSelection: true
    },
    ...overrides
  };
}
