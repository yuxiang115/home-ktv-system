import Fastify from "fastify";
import type { QueueEntry, Room, SongDiscoveryResponse, SongSearchIndexedResult } from "@home-ktv/domain";
import { describe, expect, it } from "vitest";
import type { SongCoverCacheRepository } from "../modules/covers/song-cover-cache-repository.js";
import type { SongCoverLookupKey } from "../modules/covers/types.js";
import type { KtvIndexReadRepository, SearchKtvIndexedSongsInput } from "../modules/ktv-index/ktv-index-read-repository.js";
import type { QueueEntryRepository } from "../modules/playback/repositories/queue-entry-repository.js";
import type { RoomRepository } from "../modules/rooms/repositories/room-repository.js";
import { registerSongDiscoveryRoutes } from "../routes/song-discovery.js";

const now = "2026-05-28T10:00:00.000Z";

describe("song discovery routes", () => {
  it("returns ROOM_NOT_FOUND for missing rooms", async () => {
    const { server } = await createHarness({ room: null });

    const response = await server.inject({
      method: "GET",
      url: "/rooms/missing/songs/discovery"
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: "ROOM_NOT_FOUND" });
  });

  it("returns weighted NAS recommendations plus artist and genre modules", async () => {
    const ktvIndex = new FakeKtvIndexReadRepository([
      createIndexedResult({
        indexedSongId: "ktv-song-hot",
        indexedAssetId: "ktv-asset-hot",
        title: "热门歌",
        artistName: "歌手A",
        styleTags: ["流行"],
        queueState: "queued"
      }),
      createIndexedResult({
        indexedSongId: "ktv-song-rock",
        indexedAssetId: "ktv-asset-rock",
        title: "摇滚歌",
        artistName: "歌手B",
        styleTags: ["摇滚"]
      })
    ]);
    const { server, queueEntries } = await createHarness({
      ktvIndex,
      queueEntries: [createQueueEntry({ songId: "ktv-song-hot", assetId: "ktv-asset-hot" })],
      playCounts: { "ktv-song-hot": 8, "ktv-song-rock": 2 },
      coverEntries: {
        "nas:ktv-song-hot": "https://cover.example/hot.jpg"
      }
    });

    const response = await server.inject({
      method: "GET",
      url: "/rooms/living-room/songs/discovery?seed=nas&limit=2"
    });

    expect(response.statusCode).toBe(200);
    expect(ktvIndex.searchCalls).toEqual([
      {
        query: "",
        limit: 500,
        shuffle: true,
        versionsPerSong: 1,
        queuedIndexedAssetIds: ["ktv-asset-hot"],
        unreadableIndexedAssetIds: []
      }
    ]);
    expect(queueEntries.countCalls).toEqual([["ktv-song-hot", "ktv-song-rock"]]);

    const body = response.json<SongDiscoveryResponse>();
    expect(body.seed).toBe("nas");
    expect(body.recommended).toHaveLength(2);
    expect(body.recommended).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "nas",
          songId: "ktv-song-hot",
          title: "热门歌",
          artistName: "歌手A",
          genre: ["流行"],
          queueState: "queued",
          playCount: 8,
          coverImageUrl: "https://cover.example/hot.jpg",
          versions: [
            expect.objectContaining({
              assetId: "ktv-asset-hot",
              queueState: "queued",
              sourceLabel: "NAS曲库"
            })
          ]
        })
      ])
    );
    expect(body.artists).toEqual([
      expect.objectContaining({ artistName: "歌手A", songCount: 1 }),
      expect.objectContaining({ artistName: "歌手B", songCount: 1 })
    ]);
    expect(body.genres).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ genre: "流行", songCount: 1 }),
        expect.objectContaining({ genre: "摇滚", songCount: 1 })
      ])
    );
  });

  it("returns empty discovery modules when NAS search is unavailable", async () => {
    const { server } = await createHarness();

    const response = await server.inject({
      method: "GET",
      url: "/rooms/living-room/songs/discovery?seed=empty&limit=3"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      seed: "empty",
      recommended: [],
      artists: [],
      genres: []
    });
  });
});

async function createHarness(input: {
  room?: Room | null;
  ktvIndex?: KtvIndexReadRepository;
  queueEntries?: readonly QueueEntry[];
  playCounts?: Record<string, number>;
  coverEntries?: Record<string, string>;
} = {}) {
  const server = Fastify();
  const queueEntries = new FakeQueueEntryRepository(input.queueEntries ?? [], input.playCounts ?? {});
  const coverCache = new FakeCoverCache(input.coverEntries ?? {});
  await registerSongDiscoveryRoutes(server, {
    rooms: new FakeRoomRepository(input.room === undefined ? createRoom() : input.room),
    queueEntries,
    ...(input.ktvIndex ? { ktvIndex: input.ktvIndex } : {}),
    coverCache
  });
  await server.ready();
  return { server, queueEntries, coverCache };
}

class FakeRoomRepository implements RoomRepository {
  constructor(private readonly room: Room | null) {}

  async findById(roomId: string): Promise<Room | null> {
    return this.room?.id === roomId ? { ...this.room } : null;
  }

  async findBySlug(slug: string): Promise<Room | null> {
    return this.room?.slug === slug ? { ...this.room } : null;
  }
}

class FakeKtvIndexReadRepository implements KtvIndexReadRepository {
  readonly searchCalls: SearchKtvIndexedSongsInput[] = [];

  constructor(private readonly results: readonly SongSearchIndexedResult[]) {}

  async searchIndexedSongs(input: SearchKtvIndexedSongsInput): Promise<SongSearchIndexedResult[]> {
    this.searchCalls.push(input);
    const queued = new Set(input.queuedIndexedAssetIds ?? []);
    return this.results.map((result) => ({
      ...result,
      versions: result.versions.map((version) => ({
        ...version,
        queueState: queued.has(version.indexedAssetId) ? "queued" : version.queueState
      }))
    }));
  }

  async getDiagnostics(): Promise<never> {
    throw new Error("Not implemented");
  }
}

class FakeQueueEntryRepository implements QueueEntryRepository {
  readonly countCalls: string[][] = [];

  constructor(
    private readonly queueEntries: readonly QueueEntry[],
    private readonly playCounts: Record<string, number>
  ) {}

  async listEffectiveQueue(): Promise<QueueEntry[]> {
    return this.queueEntries.map((entry) => ({ ...entry }));
  }

  async listGlobalSongRequestCounts(songIds: readonly string[]): Promise<Map<string, number>> {
    this.countCalls.push([...songIds]);
    return new Map(songIds.map((songId) => [songId, this.playCounts[songId] ?? 0]));
  }

  async findById(): Promise<QueueEntry | null> {
    return null;
  }

  async listUndoableRemoved(): Promise<QueueEntry[]> {
    return [];
  }

  async findCurrentForRoom(): Promise<QueueEntry | null> {
    return null;
  }

  async append(): Promise<never> {
    throw new Error("Not implemented");
  }

  async markRemoved(): Promise<QueueEntry | null> {
    return null;
  }

  async undoRemoved(): Promise<QueueEntry | null> {
    return null;
  }

  async renumberQueue(): Promise<QueueEntry[]> {
    return [];
  }

  async markCompleted(): Promise<QueueEntry | null> {
    return null;
  }
}

class FakeCoverCache implements Pick<SongCoverCacheRepository, "findBySongKeys"> {
  readonly lookupCalls: SongCoverLookupKey[][] = [];

  constructor(private readonly entries: Record<string, string>) {}

  async findBySongKeys(keys: readonly SongCoverLookupKey[]) {
    this.lookupCalls.push([...keys]);
    return new Map(
      keys.flatMap((key) => {
        const imageUrl = this.entries[`${key.source}:${key.sourceSongId}`];
        return imageUrl
          ? [
              [
                `${key.source}:${key.sourceSongId}`,
                {
                  source: key.source,
                  sourceSongId: key.sourceSongId,
                  imageUrl,
                  provider: "fixture",
                  providerSongId: key.sourceSongId,
                  confidence: 100
                }
              ] as const
            ]
          : [];
      })
    );
  }
}

function createRoom(): Room {
  return {
    id: "living-room",
    slug: "living-room",
    name: "Living Room",
    status: "active",
    defaultPlayerDeviceId: null,
    createdAt: now,
    updatedAt: now
  };
}

function createQueueEntry(input: { songId: string; assetId: string }): QueueEntry {
  return {
    id: "queue-1",
    roomId: "living-room",
    source: {
      sourceType: "nas",
      songId: input.songId,
      assetId: input.assetId
    },
    songId: input.songId,
    assetId: input.assetId,
    requestedBy: "phone-1",
    queuePosition: 1,
    status: "queued",
    priority: 0,
    playbackOptions: {
      preferredVocalMode: "instrumental",
      pitchSemitones: 0,
      requireReadyAsset: true
    },
    requestedAt: now,
    startedAt: null,
    endedAt: null,
    removedAt: null,
    removedByControlSessionId: null,
    undoExpiresAt: null
  };
}

function createIndexedResult(input: {
  indexedSongId: string;
  indexedAssetId: string;
  title: string;
  artistName: string;
  styleTags: string[];
  queueState?: "queued" | "not_queued";
}): SongSearchIndexedResult {
  return {
    indexedSongId: input.indexedSongId,
    title: input.title,
    artistName: input.artistName,
    styleTags: input.styleTags,
    category: input.styleTags[0] ?? "其他",
    sourceLabel: "KTV索引",
    matchReason: "title",
    versions: [
      {
        indexedAssetId: input.indexedAssetId,
        displayName: `${input.title}.mkv`,
        sourceLabel: "KTV索引",
        extension: ".mkv",
        sizeBytes: 100,
        audioTrackCount: 2,
        styleTags: input.styleTags,
        category: input.styleTags[0] ?? "其他",
        queueState: input.queueState ?? "not_queued",
        canQueue: true,
        disabledLabel: null
      }
    ]
  };
}
