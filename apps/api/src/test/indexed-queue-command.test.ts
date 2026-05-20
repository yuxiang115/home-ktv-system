import Fastify from "fastify";
import type {
  Asset,
  ControlSession,
  DeviceSession,
  PlaybackEvent,
  PlaybackSession,
  QueueEntry,
  Room,
  Song
} from "@home-ktv/domain";
import { describe, expect, it } from "vitest";
import { AssetGateway } from "../modules/assets/asset-gateway.js";
import { MediaPathResolver } from "../modules/assets/media-path-resolver.js";
import type { AssetRepository } from "../modules/catalog/repositories/asset-repository.js";
import type { SongRepository } from "../modules/catalog/repositories/song-repository.js";
import { InMemoryControlSessionRepository } from "../modules/controller/repositories/control-session-repository.js";
import type { QueryExecutor } from "../db/query-executor.js";
import type { ApiConfig } from "../config.js";
import type { PlayerDeviceSessionRepository } from "../modules/player/register-player.js";
import { buildSwitchTarget } from "../modules/playback/build-switch-target.js";
import { PgIndexedQueueCommandService } from "../modules/playback/indexed-queue-command-service.js";
import { InMemoryQueueEntryRepository } from "../modules/playback/repositories/queue-entry-repository.js";
import type { PlaybackSessionRepository } from "../modules/playback/repositories/playback-session-repository.js";
import type { RoomSessionCommandRecord } from "../modules/playback/repositories/room-session-command-repository.js";
import { executeRoomCommand } from "../modules/playback/session-command-service.js";
import type { RuntimeRepositories } from "../runtime/pg-runtime-repositories.js";
import { InMemoryRoomPairingTokenRepository } from "../modules/rooms/repositories/pairing-token-repository.js";
import type { RoomRepository } from "../modules/rooms/repositories/room-repository.js";
import { registerControlCommandRoutes } from "../routes/control-commands.js";
import { createPgRuntimeRepositories } from "../runtime/pg-runtime-repositories.js";

const now = new Date("2026-05-20T10:00:00.000Z");
const nowIso = now.toISOString();

describe("indexed queue command runtime repositories", () => {
  it("creates the PostgreSQL runtime repository bundle over any query executor", () => {
    const repositories = createPgRuntimeRepositories(new FakeQueryExecutor());

    expect(repositories.ktvIndex).toBeDefined();
    expect(repositories.queueEntries).toBeDefined();
    expect(repositories.controlCommands).toBeDefined();
    expect(repositories.playbackSessions).toBeDefined();
  });
});

describe("indexed add-queue-entry route", () => {
  it("rejects mixed canonical and indexed queue payloads", async () => {
    const server = await createControlCommandServer();

    const response = await server.inject({
      method: "POST",
      url: "/rooms/living-room/commands/add-queue-entry",
      payload: {
        commandId: "command-mixed-source",
        sessionVersion: 1,
        deviceId: "phone-1",
        songId: "song-ready",
        indexedAssetId: "ktv-asset-1"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: "INVALID_QUEUE_SOURCE", message: "点歌来源无效" });
    await server.close();
  });

  it("returns service-unavailable when indexed queueing is not wired", async () => {
    const server = await createControlCommandServer();

    const response = await server.inject({
      method: "POST",
      url: "/rooms/living-room/commands/add-queue-entry",
      payload: {
        commandId: "command-indexed-unavailable",
        sessionVersion: 1,
        deviceId: "phone-1",
        indexedAssetId: "ktv-asset-1"
      }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ code: "KTV_INDEX_SYNC_UNAVAILABLE", message: "KTV 索引点歌暂不可用" });
    await server.close();
  });

  it("broadcasts accepted indexed command snapshots like canonical commands", async () => {
    const snapshot = createSnapshot({ sessionVersion: 2 });
    const broadcasts: unknown[] = [];
    const server = await createControlCommandServer({
      indexedQueueCommands: {
        async executeIndexedAddQueueEntry(input) {
          expect(input).toMatchObject({
            commandId: "command-indexed-add",
            roomSlug: "living-room",
            sessionVersion: 1,
            deviceId: "phone-1",
            indexedAssetId: "ktv-asset-1"
          });
          return {
            status: "accepted",
            commandId: input.commandId,
            sessionVersion: 2,
            snapshot,
            controlSessionCookie: "ktv_control_session=control-session-1; Path=/"
          };
        }
      },
      broadcaster: {
        broadcastRoomSnapshot(roomSlug: string, payload: unknown) {
          broadcasts.push({ roomSlug, payload });
        }
      }
    });

    const response = await server.inject({
      method: "POST",
      url: "/rooms/living-room/commands/add-queue-entry",
      headers: { cookie: "ktv_control_session=control-session-1" },
      payload: {
        commandId: "command-indexed-add",
        sessionVersion: 1,
        deviceId: "phone-1",
        indexedAssetId: "ktv-asset-1"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toContain("ktv_control_session=control-session-1");
    expect(response.json()).toMatchObject({
      status: "accepted",
      commandId: "command-indexed-add",
      sessionVersion: 2,
      snapshot
    });
    expect(broadcasts).toEqual([{ roomSlug: "living-room", payload: snapshot }]);
    await server.close();
  });
});

describe("PgIndexedQueueCommandService", () => {
  it("syncs the indexed asset and appends a canonical queue entry in one transaction", async () => {
    const client = new FakeIndexedTransactionClient();
    const queueEntries = new InMemoryQueueEntryRepository();
    const service = createIndexedQueueCommandService({ client, queueEntries });

    const result = await service.executeIndexedAddQueueEntry({
      commandId: "command-indexed-queue",
      roomSlug: "living-room",
      sessionVersion: 1,
      deviceId: "phone-1",
      indexedAssetId: "ktv-asset-1",
      cookieHeader: "ktv_control_session=control-session-1"
    });

    expect(result.status).toBe("accepted");
    expect(client.transactionStatements).toEqual(["BEGIN", "COMMIT"]);
    await expect(queueEntries.listEffectiveQueue("living-room")).resolves.toEqual([
      expect.objectContaining({
        songId: "song-ktv-ktv-song-1",
        assetId: "asset-ktv-ktv-asset-1"
      })
    ]);
  });

  it("maps stale indexed sources to a stable rejected command result", async () => {
    const service = createIndexedQueueCommandService({
      client: new FakeIndexedTransactionClient({ missingAt: new Date("2026-05-20T00:00:00Z") })
    });

    const result = await service.executeIndexedAddQueueEntry({
      commandId: "command-stale-indexed",
      roomSlug: "living-room",
      sessionVersion: 1,
      deviceId: "phone-1",
      indexedAssetId: "ktv-asset-1",
      cookieHeader: "ktv_control_session=control-session-1"
    });

    expect(result).toMatchObject({
      status: "rejected",
      commandId: "command-stale-indexed",
      sessionVersion: 1,
      code: "KTV_INDEX_ASSET_STALE",
      message: "索引已失效"
    });
  });

  it("maps unreadable indexed files to a stable rejected command result", async () => {
    const service = createIndexedQueueCommandService({
      client: new FakeIndexedTransactionClient({
        row: createIndexedAssetRow({
          file_path: "/definitely/not/readable/ktv-asset-1.mkv",
          source_root: "/"
        })
      })
    });

    const result = await service.executeIndexedAddQueueEntry({
      commandId: "command-unreadable-indexed",
      roomSlug: "living-room",
      sessionVersion: 1,
      deviceId: "phone-1",
      indexedAssetId: "ktv-asset-1",
      cookieHeader: "ktv_control_session=control-session-1"
    });

    expect(result).toMatchObject({
      status: "rejected",
      commandId: "command-unreadable-indexed",
      sessionVersion: 1,
      code: "KTV_INDEX_FILE_UNREADABLE",
      message: "文件不可读"
    });
  });

  it("rolls back when queue append fails after sync", async () => {
    const client = new FakeIndexedTransactionClient();
    const service = createIndexedQueueCommandService({
      client,
      queueEntries: new FailingAppendQueueEntryRepository()
    });

    await expect(
      service.executeIndexedAddQueueEntry({
        commandId: "command-rollback",
        roomSlug: "living-room",
        sessionVersion: 1,
        deviceId: "phone-1",
        indexedAssetId: "ktv-asset-1",
        cookieHeader: "ktv_control_session=control-session-1"
      })
    ).rejects.toThrow("append failed");

    expect(client.transactionStatements).toEqual(["BEGIN", "ROLLBACK"]);
  });
});

describe("ktv-index queue admission", () => {
  it("accepts indexed-synced real MV assets with unknown compatibility and null track roles without storing indexed ids", async () => {
    const queueEntries = new InMemoryQueueEntryRepository();
    const repositories = createRuntimeRepositories({
      queueEntries,
      songs: [createSyncedSong()],
      assets: [createKtvIndexSyncedRealMvAsset()]
    });
    const assetGateway = createAssetGateway(createAssetRepository([createKtvIndexSyncedRealMvAsset()]));

    const result = await executeRoomCommand({
      commandId: "command-ktv-index-real-mv-admission",
      roomSlug: "living-room",
      sessionVersion: 1,
      type: "add-queue-entry",
      payload: {
        songId: "song-ktv-ktv-song-1",
        assetId: "asset-ktv-ktv-asset-1",
        queueAdmissionSource: "ktv-index",
        indexedAssetId: "ktv-asset-1"
      },
      controlSession: createControlSessionInfo(),
      repositories,
      assetGateway,
      config: createConfig(),
      now
    });

    expect(result.status).toBe("accepted");
    const queue = await queueEntries.listEffectiveQueue("living-room");
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      songId: "song-ktv-ktv-song-1",
      assetId: "asset-ktv-ktv-asset-1"
    });
    expect(Object.prototype.hasOwnProperty.call(queue[0], "indexedAssetId")).toBe(false);

    await expect(
      buildSwitchTarget({
        roomSlug: "living-room",
        repositories,
        assetGateway
      })
    ).resolves.toBeNull();
  });

  it("still rejects equivalent non-KTV real MV assets with null track roles", async () => {
    const queueEntries = new InMemoryQueueEntryRepository();
    const repositories = createRuntimeRepositories({
      queueEntries,
      songs: [createSyncedSong()],
      assets: [createKtvIndexSyncedRealMvAsset()]
    });

    const result = await executeRoomCommand({
      commandId: "command-non-ktv-real-mv-admission",
      roomSlug: "living-room",
      sessionVersion: 1,
      type: "add-queue-entry",
      payload: {
        songId: "song-ktv-ktv-song-1",
        assetId: "asset-ktv-ktv-asset-1"
      },
      controlSession: createControlSessionInfo(),
      repositories,
      assetGateway: createAssetGateway(createAssetRepository([createKtvIndexSyncedRealMvAsset()])),
      config: createConfig(),
      now
    });

    expect(result).toMatchObject({
      status: "rejected",
      code: "SONG_NOT_QUEUEABLE"
    });
    await expect(queueEntries.listEffectiveQueue("living-room")).resolves.toEqual([]);
  });
});

class FakeQueryExecutor implements QueryExecutor {
  async query<TRow>(): Promise<{ rows: TRow[] }> {
    return { rows: [] };
  }
}

function createIndexedQueueCommandService(input: {
  client: FakeIndexedTransactionClient;
  queueEntries?: InMemoryQueueEntryRepository;
}): PgIndexedQueueCommandService {
  const queueEntries = input.queueEntries ?? new InMemoryQueueEntryRepository();

  return new PgIndexedQueueCommandService({
    pool: {
      async connect() {
        return input.client;
      }
    } as any,
    config: createConfig(),
    assetGateway: createAssetGateway(createAssetRepository([createQueueableSyncedAsset()])),
    createRepositories: () =>
      createRuntimeRepositories({
        queueEntries,
        songs: [createSyncedSong()],
        assets: [
          createQueueableSyncedAsset(),
          createQueueableSyncedAsset({
            id: "asset-ktv-ktv-asset-1-original",
            vocalMode: "original"
          })
        ]
      })
  });
}

async function createControlCommandServer(input: {
  indexedQueueCommands?: Parameters<typeof registerControlCommandRoutes>[1]["indexedQueueCommands"];
  broadcaster?: { broadcastRoomSnapshot(roomSlug: string, payload: unknown): void };
} = {}) {
  const server = Fastify();
  await registerControlCommandRoutes(server, {
    config: createConfig(),
    repositories: createRuntimeRepositories(),
    assetGateway: createAssetGateway(createAssetRepository()),
    ...(input.indexedQueueCommands ? { indexedQueueCommands: input.indexedQueueCommands } : {}),
    ...(input.broadcaster ? { broadcaster: input.broadcaster as any } : {})
  });
  await server.ready();
  return server;
}

function createRuntimeRepositories(input: {
  queueEntries?: InMemoryQueueEntryRepository;
  songs?: Song[];
  assets?: Asset[];
} = {}): RuntimeRepositories {
  const room = createRoom();
  const queueEntries = input.queueEntries ?? new InMemoryQueueEntryRepository();
  const assets = createAssetRepository(input.assets ?? [createReadyAsset(), createReadyAsset({ id: "asset-ready-original", vocalMode: "original" })]);
  return {
    rooms: new FakeRoomRepository(room),
    playbackSessions: new FakePlaybackSessionRepository(),
    queueEntries,
    assets,
    songs: createSongRepository(input.songs ?? [createSong("song-ready", "Ready Song", "Artist Ready", "asset-ready")]) as RuntimeRepositories["songs"],
    pairingTokens: new InMemoryRoomPairingTokenRepository(),
    controlSessions: new InMemoryControlSessionRepository([createControlSession()]),
    controlCommands: new FakeRoomSessionCommandRepository(),
    deviceSessions: new FakeDeviceSessionRepository(),
    playbackEvents: new FakePlaybackEventRepository()
  };
}

class FakeIndexedTransactionClient implements QueryExecutor {
  readonly transactionStatements: string[] = [];
  readonly songs = new Map<string, Record<string, unknown>>();
  readonly assets = new Map<string, Record<string, unknown>>();
  readonly sourceRecords: Array<Record<string, unknown>> = [];
  private readonly row: FakeIndexedAssetRow | null;

  constructor(input: { row?: FakeIndexedAssetRow | null; missingAt?: Date | null } = {}) {
    this.row = input.row === null ? null : input.row ?? createIndexedAssetRow({ missing_at: input.missingAt ?? null });
  }

  async query<TRow>(text: string, values: readonly unknown[] = []): Promise<{ rows: TRow[] }> {
    const normalized = text.trim();
    if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
      this.transactionStatements.push(normalized);
      return { rows: [] };
    }

    if (text.includes("FROM source_records")) {
      return { rows: [] };
    }

    if (text.includes("FROM ktv_song_assets")) {
      return { rows: this.row && this.row.id === values[0] ? ([this.row] as TRow[]) : [] };
    }

    if (text.includes("INSERT INTO songs")) {
      this.songs.set(String(values[0]), {
        id: values[0],
        title: values[1],
        artistName: values[6],
        defaultAssetId: null
      });
      return { rows: [] };
    }

    if (text.includes("INSERT INTO assets")) {
      this.assets.set(String(values[0]), {
        id: values[0],
        songId: values[1],
        displayName: values[2],
        filePath: values[3]
      });
      return { rows: [] };
    }

    if (text.includes("INSERT INTO source_records")) {
      this.sourceRecords.push({
        id: values[0],
        assetId: values[1],
        providerItemId: values[2],
        sourceUri: values[3],
        rawMeta: values[4]
      });
      return { rows: [] };
    }

    if (text.includes("UPDATE songs") && text.includes("default_asset_id")) {
      const song = this.songs.get(String(values[0]));
      if (song) {
        song.defaultAssetId = values[1];
      }
      return { rows: [] };
    }

    return { rows: [] };
  }

  release(): void {
    return undefined;
  }
}

interface FakeIndexedAssetRow {
  id: string;
  song_id: string;
  file_path: string;
  relative_path: string;
  file_name: string;
  extension: string;
  size_bytes: number | string | null;
  parse_confidence: number | string;
  missing_at: Date | string | null;
  title: string;
  primary_artist_name: string;
  category: string;
  source_root: string | null;
}

function createIndexedAssetRow(input: Partial<FakeIndexedAssetRow> = {}): FakeIndexedAssetRow {
  return {
    id: "ktv-asset-1",
    song_id: "ktv-song-1",
    file_path: `${process.cwd()}/package.json`,
    relative_path: "package.json",
    file_name: "package.json",
    extension: ".mkv",
    size_bytes: "123456",
    parse_confidence: "0.980",
    missing_at: null,
    title: "七里香",
    primary_artist_name: "周杰伦",
    category: "流行",
    source_root: process.cwd(),
    ...input
  };
}

class FailingAppendQueueEntryRepository extends InMemoryQueueEntryRepository {
  async append(): Promise<QueueEntry> {
    throw new Error("append failed");
  }
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
  private session: PlaybackSession = {
    roomId: "living-room",
    currentQueueEntryId: null,
    nextQueueEntryId: null,
    activeAssetId: null,
    targetVocalMode: "instrumental",
    playerState: "idle",
    playerPositionMs: 0,
    mediaStartedAt: null,
    version: 1,
    updatedAt: nowIso
  };

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
      activeAssetId: input.activeAssetId,
      targetVocalMode: input.targetVocalMode ?? this.session.targetVocalMode,
      playerState: input.playerState ?? "playing",
      playerPositionMs: input.playerPositionMs ?? 0,
      nextQueueEntryId: input.nextQueueEntryId ?? null,
      mediaStartedAt: input.mediaStartedAt?.toISOString() ?? null,
      version: this.session.version + 1,
      updatedAt: nowIso
    };
    return { ...this.session };
  }

  async setIdle(roomId: string): Promise<PlaybackSession | null> {
    if (roomId !== this.session.roomId) {
      return null;
    }
    this.session = {
      ...this.session,
      currentQueueEntryId: null,
      activeAssetId: null,
      nextQueueEntryId: null,
      playerState: "idle",
      playerPositionMs: 0,
      mediaStartedAt: null,
      version: this.session.version + 1,
      updatedAt: nowIso
    };
    return { ...this.session };
  }

  async requestSwitchTarget(input: Parameters<PlaybackSessionRepository["requestSwitchTarget"]>[0]): Promise<PlaybackSession | null> {
    this.session = {
      ...this.session,
      targetVocalMode: input.targetVocalMode,
      version: this.session.version + 1,
      updatedAt: nowIso
    };
    return { ...this.session };
  }

  async bumpVersion(): Promise<PlaybackSession | null> {
    this.session = { ...this.session, version: this.session.version + 1, updatedAt: nowIso };
    return { ...this.session };
  }

  async updatePlayerPosition(): Promise<PlaybackSession | null> {
    return { ...this.session };
  }

  async updatePlaybackFacts(): Promise<PlaybackSession | null> {
    return { ...this.session };
  }
}

class FakeRoomSessionCommandRepository {
  private readonly records = new Map<string, RoomSessionCommandRecord>();

  async findCommand(commandId: string): Promise<RoomSessionCommandRecord | null> {
    return this.records.get(commandId) ?? null;
  }

  async insertCommandAttempt(input: RoomSessionCommandRecord): Promise<RoomSessionCommandRecord> {
    const record = { ...input, createdAt: nowIso };
    this.records.set(record.commandId, record);
    return record;
  }

  async updateCommandResult(): Promise<null> {
    return null;
  }
}

class FakeDeviceSessionRepository implements PlayerDeviceSessionRepository {
  async findActiveTvPlayer(): Promise<DeviceSession | null> {
    return null;
  }

  async upsertTvPlayer(): Promise<DeviceSession> {
    return createDeviceSession();
  }

  async updateTvHeartbeat(): Promise<null> {
    return null;
  }
}

class FakePlaybackEventRepository {
  async append<TPayload extends Record<string, unknown>>(): Promise<PlaybackEvent<TPayload>> {
    return {
      id: "event-1",
      roomId: "living-room",
      queueEntryId: null,
      eventType: "test",
      eventPayload: {} as TPayload,
      createdAt: nowIso
    };
  }
}

function createSongRepository(songs: readonly Song[]): SongRepository {
  const byId = new Map(songs.map((song) => [song.id, song]));
  return {
    async findById(songId: string) {
      const song = byId.get(songId);
      return song ? { ...song } : null;
    }
  };
}

function createAssetRepository(assets: readonly Asset[] = []): AssetRepository {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  return {
    async findById(assetId: string) {
      const asset = byId.get(assetId);
      return asset ? ({ ...asset, trackRoles: asset.trackRoles ? { ...asset.trackRoles } : asset.trackRoles } as Asset) : null;
    },
    async findVerifiedSwitchCounterparts(asset: Asset) {
      return [...byId.values()].filter(
        (candidate) =>
          candidate.songId === asset.songId &&
          candidate.id !== asset.id &&
          candidate.switchFamily === asset.switchFamily &&
          candidate.vocalMode !== asset.vocalMode &&
          candidate.status === "ready" &&
          candidate.switchQualityStatus === "verified"
      );
    }
  };
}

function createAssetGateway(assetRepository: AssetRepository): AssetGateway {
  return new AssetGateway({
    assetRepository,
    mediaPathResolver: new MediaPathResolver({ mediaRoot: "/media-root" }),
    publicBaseUrl: "http://ktv.local"
  });
}

function createConfig(): ApiConfig {
  return {
    corsAllowedOrigins: [],
    databaseUrl: "",
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

function createRoom(): Room {
  return {
    id: "living-room",
    slug: "living-room",
    name: "Living Room",
    status: "active",
    defaultPlayerDeviceId: null,
    createdAt: nowIso,
    updatedAt: nowIso
  };
}

function createControlSession(): ControlSession {
  return {
    id: "control-session-1",
    roomId: "living-room",
    deviceId: "phone-1",
    deviceName: "Mobile Controller",
    lastSeenAt: nowIso,
    expiresAt: "2030-01-01T00:00:00.000Z",
    revokedAt: null,
    createdAt: nowIso,
    updatedAt: nowIso
  };
}

function createControlSessionInfo() {
  return {
    id: "control-session-1",
    roomId: "living-room",
    roomSlug: "living-room",
    deviceId: "phone-1",
    deviceName: "Mobile Controller",
    lastSeenAt: nowIso,
    expiresAt: "2030-01-01T00:00:00.000Z"
  };
}

function createSyncedSong(): Song {
  return createSong("song-ktv-ktv-song-1", "七里香", "周杰伦", "asset-ktv-ktv-asset-1");
}

function createSong(id: string, title: string, artistName: string, defaultAssetId: string): Song {
  return {
    id,
    title,
    normalizedTitle: title.toLowerCase(),
    titlePinyin: "",
    titleInitials: "",
    artistId: `artist-${id}`,
    artistName,
    language: "mandarin",
    status: "ready",
    genre: [],
    tags: [],
    aliases: [],
    searchHints: [],
    releaseYear: null,
    canonicalDurationMs: 180000,
    searchWeight: 0,
    defaultAssetId,
    capabilities: { canSwitchVocalMode: true },
    createdAt: nowIso,
    updatedAt: nowIso
  };
}

function createQueueableSyncedAsset(input: Partial<Asset> = {}): Asset {
  return createReadyAsset({
    id: "asset-ktv-ktv-asset-1",
    songId: "song-ktv-ktv-song-1",
    vocalMode: "instrumental",
    switchFamily: "family-ktv-1",
    ...input
  });
}

function createKtvIndexSyncedRealMvAsset(input: Partial<Asset> = {}): Asset {
  return createReadyAsset({
    id: "asset-ktv-ktv-asset-1",
    songId: "song-ktv-ktv-song-1",
    assetKind: "dual-track-video",
    displayName: "七里香",
    filePath: "/media-root/package.json",
    vocalMode: "dual",
    switchFamily: null,
    switchQualityStatus: "review_required",
    compatibilityStatus: "unknown",
    trackRoles: { original: null, instrumental: null },
    playbackProfile: {
      kind: "single_file_audio_tracks",
      container: "matroska",
      videoCodec: null,
      audioCodecs: [],
      requiresAudioTrackSelection: false
    },
    ...input
  });
}

function createReadyAsset(input: Partial<Asset> = {}): Asset {
  return {
    id: "asset-ready",
    songId: "song-ready",
    sourceType: "local",
    assetKind: "video",
    displayName: "Ready Asset",
    filePath: "ready.mp4",
    durationMs: 180000,
    lyricMode: "hard_sub",
    vocalMode: "instrumental",
    status: "ready",
    switchFamily: "family-ready",
    switchQualityStatus: "verified",
    createdAt: nowIso,
    updatedAt: nowIso,
    ...input
  };
}

function createDeviceSession(): DeviceSession {
  return {
    id: "tv-1",
    roomId: "living-room",
    deviceType: "tv",
    deviceName: "Living Room TV",
    lastSeenAt: nowIso,
    capabilities: {},
    pairingToken: "token-1",
    createdAt: nowIso,
    updatedAt: nowIso
  };
}

function createSnapshot(input: { sessionVersion: number }) {
  return {
    type: "room.control.snapshot" as const,
    roomId: "living-room",
    roomSlug: "living-room",
    sessionVersion: input.sessionVersion,
    state: "idle" as const,
    pairing: {
      roomSlug: "living-room",
      controllerUrl: "http://ktv.local/controller",
      qrPayload: "http://ktv.local/controller",
      token: "token-1",
      tokenExpiresAt: nowIso
    },
    tvPresence: { online: false, deviceName: null, lastSeenAt: null, conflict: null },
    controllers: { onlineCount: 1 },
    currentTarget: null,
    switchTarget: null,
    targetVocalMode: "instrumental" as const,
    queue: [],
    recentEvents: [],
    onlineTasks: { counts: { total: 0 }, tasks: [] },
    notice: null,
    generatedAt: nowIso
  };
}
