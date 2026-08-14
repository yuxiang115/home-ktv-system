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
  it("rejects queue commands without a logged-in controller user", async () => {
    const playableAsset = createPlayableMediaAsset();
    const server = await createControlCommandServer({ playableMedia: [playableAsset] });

    const response = await server.inject({
      method: "POST",
      url: "/rooms/living-room/commands/add-queue-entry",
      headers: { cookie: "ktv_control_session=control-session-1; ktv_controller_auth=auth-token" },
      payload: {
        commandId: "command-add-nas-guest",
        sessionVersion: 1,
        deviceId: "phone-1",
        sourceType: "nas",
        assetId: playableAsset.assetId
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ code: "AUTH_REQUIRED", message: null });
    await server.close();
  });

  it("queues NAS songs by source asset and returns a NAS snapshot", async () => {
    const playableAsset = createPlayableMediaAsset();
    const server = await createControlCommandServer({ loggedInUser: createControllerUser(), playableMedia: [playableAsset] });

    const response = await server.inject({
      method: "POST",
      url: "/rooms/living-room/commands/add-queue-entry",
      headers: { cookie: "ktv_control_session=control-session-1; ktv_controller_auth=auth-token" },
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
            requestedByName: "阿飞",
            status: "loading"
          }
        ]
      }
    });

    await server.close();
  });

  it("rejects retired indexed queue payloads instead of syncing them", async () => {
    const server = await createControlCommandServer({ loggedInUser: createControllerUser(), playableMedia: [createPlayableMediaAsset()] });

    const response = await server.inject({
      method: "POST",
      url: "/rooms/living-room/commands/add-queue-entry",
      headers: { cookie: "ktv_control_session=control-session-1; ktv_controller_auth=auth-token" },
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

  it("rejects online queue payloads because online supplement is retired", async () => {
    const server = await createControlCommandServer({ loggedInUser: createControllerUser(), playableMedia: [createPlayableMediaAsset()] });

    const response = await server.inject({
      method: "POST",
      url: "/rooms/living-room/commands/add-queue-entry",
      headers: { cookie: "ktv_control_session=control-session-1; ktv_controller_auth=auth-token" },
      payload: {
        commandId: "command-online-not-ready",
        sessionVersion: 1,
        deviceId: "phone-1",
        sourceType: "online",
        assetId: "online-asset-1"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: "INVALID_QUEUE_SOURCE", message: null });
    await server.close();
  });

  it("shuffles the playback queue by interleaving different requesters", async () => {
    const queueEntries = [
      createQueueEntry({ id: "current", songId: "song-current", assetId: "asset-current", status: "playing", queuePosition: 1, requester: "user-a" }),
      createQueueEntry({ id: "a-1", songId: "song-a-1", assetId: "asset-a-1", queuePosition: 2, requester: "user-a" }),
      createQueueEntry({ id: "a-2", songId: "song-a-2", assetId: "asset-a-2", queuePosition: 3, requester: "user-a" }),
      createQueueEntry({ id: "b-1", songId: "song-b-1", assetId: "asset-b-1", queuePosition: 4, requester: "user-b" }),
      createQueueEntry({ id: "b-2", songId: "song-b-2", assetId: "asset-b-2", queuePosition: 5, requester: "user-b" }),
      createQueueEntry({ id: "c-1", songId: "song-c-1", assetId: "asset-c-1", queuePosition: 6, requester: "user-c" })
    ];
    const playableMedia = queueEntries.map((entry) =>
      createPlayableMediaAsset({
        songId: entry.songId,
        assetId: entry.assetId,
        title: entry.id,
        artistName: `artist-${entry.requestedBy}`
      })
    );
    const server = await createControlCommandServer({
      loggedInUser: createControllerUser(),
      playableMedia,
      queueEntries
    });

    const response = await server.inject({
      method: "POST",
      url: "/rooms/living-room/commands/shuffle-queue",
      headers: { cookie: "ktv_control_session=control-session-1; ktv_controller_auth=auth-token" },
      payload: {
        commandId: "command-shuffle-route",
        sessionVersion: 1,
        deviceId: "phone-1"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "accepted",
      commandId: "command-shuffle-route",
      snapshot: {
        queue: [
          { queueEntryId: "current" },
          { queueEntryId: "a-1" },
          { queueEntryId: "b-1" },
          { queueEntryId: "c-1" },
          { queueEntryId: "a-2" },
          { queueEntryId: "b-2" }
        ]
      }
    });
    await server.close();
  });
});

async function createControlCommandServer(input: {
  loggedInUser?: { phone: string; displayName: string };
  playableMedia: readonly PlayableMediaAsset[];
  queueEntries?: readonly QueueEntry[];
}) {
  const room = createRoom();
  const queueEntries = new InMemoryQueueEntryRepository(input.queueEntries ?? []);
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
      controllerAuth: new FakeControllerAuthSessionRepository(input.loggedInUser ?? null),
      controlCommands: new FakeRoomSessionCommandRepository(),
      deviceSessions: new FakeDeviceSessionRepository()
    },
    mediaGateway
  });

  await server.ready();
  return server;
}

class FakeControllerAuthSessionRepository {
  constructor(private readonly user: { phone: string; displayName: string } | null) {}

  async createUser(): Promise<never> {
    throw new Error("Not implemented");
  }

  async findUserByPhone(): Promise<null> {
    return null;
  }

  async updateDisplayName(): Promise<null> {
    return null;
  }

  async createSession(): Promise<void> {}

  async findUserByToken(): Promise<ReturnType<typeof createControllerUser> | null> {
    return this.user ? createControllerUser(this.user) : null;
  }

  async touchSession(): Promise<void> {}

  async revokeSession(): Promise<void> {}
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
    onlineSupplementEnabled: false,
    onlineSupplementWorkflow: "youtube-enhanced",
    supplementImportRoot: "",
    supplementBatchSize: 4,
    supplementBatchTimeoutSec: 30,
    lyricsLrclibBaseUrl: "https://lrclib.net",
    ytDlpBin: "yt-dlp",
    ytDlpArgs: "",
    youtubePlayerClient: "android",
    youtubeCookie: "",
    youtubeCookiesFromBrowser: "",
    demucsBin: "demucs",
    demucsArgs: "",
    demucsDevice: "cpu",
    demucsModel: "htdemucs",
    ffmpegBin: "ffmpeg",
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
    userPhone: null,
    lastSeenAt: now.toISOString(),
    expiresAt: "2099-01-01T00:00:00.000Z",
    revokedAt: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
}

function createControllerUser(overrides: Partial<{ phone: string; displayName: string }> = {}) {
  return {
    phone: "13800138000",
    displayName: "阿飞",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    lastLoginAt: now.toISOString(),
    ...overrides
  };
}

function createPlayableMediaAsset(overrides: Partial<PlayableMediaAsset> = {}): PlayableMediaAsset {
  return {
    sourceType: "nas",
    songId: "ktv-song-1",
    assetId: "ktv-song-1",
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

function createQueueEntry(input: {
  id: string;
  songId: string;
  assetId: string;
  queuePosition: number;
  requester: string;
  status?: QueueEntry["status"];
}): QueueEntry {
  return {
    id: input.id,
    roomId: "living-room",
    source: { sourceType: "nas", songId: input.songId, assetId: input.assetId },
    songId: input.songId,
    assetId: input.assetId,
    requestedBy: input.requester,
    requestedByUserPhone: input.requester,
    requestedByName: input.requester,
    queuePosition: input.queuePosition,
    status: input.status ?? "queued",
    priority: 0,
    playbackOptions: {
      preferredVocalMode: "instrumental",
      pitchSemitones: 0,
      requireReadyAsset: true
    },
    requestedAt: now.toISOString(),
    startedAt: input.status === "playing" ? now.toISOString() : null,
    endedAt: null,
    removedAt: null,
    removedByControlSessionId: null,
    undoExpiresAt: null
  };
}
