import Fastify from "fastify";
import type {
  QueueEntry,
  Room,
  SongDiscoveryResponse,
  SongSearchIndexedResult,
  SongSearchVersionOption
} from "@home-ktv/domain";
import type {
  AdminCatalogSongRepository,
  SearchFormalSongRecord,
  SearchFormalSongsInput
} from "../modules/catalog/repositories/song-repository.js";
import type { KtvIndexReadRepository } from "../modules/ktv-index/ktv-index-read-repository.js";
import type { QueueEntryRepository } from "../modules/playback/repositories/queue-entry-repository.js";
import type { RoomRepository } from "../modules/rooms/repositories/room-repository.js";
import { type IndexedSourceIdentityLookup, registerSongDiscoveryRoutes } from "../routes/song-discovery.js";
import { describe, expect, it, vi } from "vitest";

const now = "2026-05-27T00:00:00.000Z";

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

  it("returns weighted recommendations plus artist and genre modules", async () => {
    const { server, songs, queueEntries } = await createHarness({
      searchResults: [
        createSearchRecord({ id: "song-hot", title: "热门歌", artistId: "artist-a", artistName: "歌手A", genre: ["流行"] }),
        createSearchRecord({ id: "song-mid", title: "中等歌", artistId: "artist-a", artistName: "歌手A", genre: ["流行"] }),
        createSearchRecord({ id: "song-rock", title: "摇滚歌", artistId: "artist-b", artistName: "歌手B", genre: ["摇滚"] }),
        createSearchRecord({ id: "song-queued", title: "已点歌", artistId: "artist-c", artistName: "歌手C", genre: ["民谣"], queueState: "queued" })
      ],
      queueEntries: [createQueueEntry({ songId: "song-queued" })],
      playCounts: { "song-hot": 12, "song-mid": 3, "song-rock": 0, "song-queued": 1 }
    });

    const response = await server.inject({
      method: "GET",
      url: "/rooms/living-room/songs/discovery?seed=test-seed&limit=3"
    });

    expect(response.statusCode).toBe(200);
    expect(songs.searchCalls).toEqual([{ query: "", limit: 500, queuedSongIds: ["song-queued"] }]);
    expect(queueEntries.countCalls).toEqual([["song-hot", "song-mid", "song-rock", "song-queued"]]);
    const body = response.json<SongDiscoveryResponse>();
    expect(body.seed).toBe("test-seed");
    expect(body.recommended).toHaveLength(3);
    expect(body.recommended.map((song) => song.songId)).toContain("song-hot");
    expect(body.recommended[0]).toMatchObject({
      title: expect.any(String),
      versions: expect.any(Array),
      playCount: expect.any(Number),
      recommendationWeight: expect.any(Number)
    });
    expect(body.artists).toEqual([
      expect.objectContaining({
        artistId: "artist-a",
        artistName: "歌手A",
        songCount: 2,
        songs: expect.arrayContaining([expect.objectContaining({ songId: "song-hot" })])
      }),
      expect.objectContaining({ artistId: "artist-c", artistName: "歌手C", songCount: 1 }),
      expect.objectContaining({ artistId: "artist-b", artistName: "歌手B", songCount: 1 })
    ]);
    expect(body.genres).toEqual([
      expect.objectContaining({ genre: "流行", songCount: 2 }),
      expect.objectContaining({ genre: "民谣", songCount: 1 }),
      expect.objectContaining({ genre: "摇滚", songCount: 1 })
    ]);
    expect(
      body.artists
        .flatMap((artist) => artist.songs)
        .find((song) => song.songId === "song-queued")
        ?.queueState
    ).toBe("queued");
  });

  it("uses KTV index songs for discovery when the formal catalog is empty", async () => {
    const { server, ktvIndex, indexedSources, queueEntries } = await createHarness({
      searchResults: [],
      indexedResults: [
        createIndexedResult({
          indexedSongId: "indexed-hot",
          indexedAssetId: "indexed-asset-hot",
          title: "海阔天空",
          artistName: "Beyond",
          styleTags: ["粤语", "流行"],
          queueState: "queued"
        }),
        createIndexedResult({
          indexedSongId: "indexed-rock",
          indexedAssetId: "indexed-asset-rock",
          title: "倔强",
          artistName: "五月天",
          styleTags: ["摇滚"]
        })
      ],
      indexedAssetIdsForCanonicalAssets: ["indexed-asset-hot"],
      queueEntries: [
        createQueueEntry({
          songId: "song-ktv-indexed-hot",
          assetId: "asset-ktv-indexed-asset-hot"
        })
      ],
      playCounts: {
        "song-ktv-indexed-hot": 8,
        "song-ktv-indexed-rock": 2
      }
    });

    const response = await server.inject({
      method: "GET",
      url: "/rooms/living-room/songs/discovery?seed=ktv-index&limit=2"
    });

    expect(response.statusCode).toBe(200);
    expect(indexedSources.lookupCalls).toEqual([["asset-ktv-indexed-asset-hot"]]);
    expect(ktvIndex.searchCalls).toEqual([
      {
        query: "",
        limit: 500,
        shuffle: true,
        versionsPerSong: 1,
        queuedIndexedAssetIds: ["indexed-asset-hot"],
        unreadableIndexedAssetIds: []
      }
    ]);
    expect(queueEntries.countCalls).toEqual([["song-ktv-indexed-hot", "song-ktv-indexed-rock"]]);

    const body = response.json<SongDiscoveryResponse>();
    expect(body.recommended).toHaveLength(2);
    expect(body.recommended).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "ktv-index",
          songId: "song-ktv-indexed-hot",
          indexedSongId: "indexed-hot",
          title: "海阔天空",
          artistId: "ktv-index-artist-beyond",
          artistName: "Beyond",
          genre: ["粤语", "流行"],
          queueState: "queued",
          playCount: 8,
          versions: [
            expect.objectContaining({
              indexedAssetId: "indexed-asset-hot",
              queueState: "queued",
              canQueue: true
            })
          ]
        })
      ])
    );
    expect(body.artists).toEqual([
      expect.objectContaining({ artistId: "ktv-index-artist-beyond", artistName: "Beyond", songCount: 1 }),
      expect.objectContaining({ artistName: "五月天", songCount: 1 })
    ]);
    expect(body.genres).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ genre: "粤语", songCount: 1 }),
        expect.objectContaining({ genre: "流行", songCount: 1 }),
        expect.objectContaining({ genre: "摇滚", songCount: 1 })
      ])
    );
  });
});

async function createHarness(input: {
  room?: Room | null;
  searchResults?: SearchFormalSongRecord[];
  indexedResults?: SongSearchIndexedResult[];
  indexedAssetIdsForCanonicalAssets?: string[];
  queueEntries?: QueueEntry[];
  playCounts?: Record<string, number>;
} = {}) {
  const server = Fastify({ logger: false });
  const rooms = new FakeRoomRepository(input.room === undefined ? createRoom() : input.room);
  const songs = new FakeSongRepository(input.searchResults ?? []);
  const ktvIndex = new FakeKtvIndexReadRepository(input.indexedResults ?? []);
  const indexedSources = new FakeIndexedSourceIdentityLookup(input.indexedAssetIdsForCanonicalAssets ?? []);
  const queueEntries = new FakeQueueEntryRepository(input.queueEntries ?? [], input.playCounts ?? {});

  await registerSongDiscoveryRoutes(server, {
    rooms,
    songs,
    queueEntries,
    ktvIndex,
    indexedSources
  });

  return { server, rooms, songs, ktvIndex, indexedSources, queueEntries };
}

class FakeRoomRepository implements RoomRepository {
  constructor(private readonly room: Room | null) {}

  async findById(roomId: string): Promise<Room | null> {
    return this.room?.id === roomId ? this.room : null;
  }

  async findBySlug(slug: string): Promise<Room | null> {
    return this.room?.slug === slug ? this.room : null;
  }
}

class FakeSongRepository implements AdminCatalogSongRepository {
  readonly searchFormalSongs = vi.fn(async (input: SearchFormalSongsInput) => {
    this.searchCalls.push(input);
    return this.results;
  });

  readonly searchCalls: SearchFormalSongsInput[] = [];

  constructor(private readonly results: SearchFormalSongRecord[]) {}

  async listFormalSongs() {
    return [];
  }

  async getFormalSongWithAssets() {
    return null;
  }

  async updateSongMetadata() {
    return null;
  }

  async updateDefaultAsset() {
    return null;
  }

  async updateSongStatus() {
    return null;
  }
}

class FakeKtvIndexReadRepository implements Pick<KtvIndexReadRepository, "searchIndexedSongs"> {
  readonly searchCalls: Parameters<KtvIndexReadRepository["searchIndexedSongs"]>[0][] = [];

  constructor(private readonly results: SongSearchIndexedResult[]) {}

  async searchIndexedSongs(input: Parameters<KtvIndexReadRepository["searchIndexedSongs"]>[0]) {
    this.searchCalls.push(input);
    return this.results;
  }
}

class FakeIndexedSourceIdentityLookup implements IndexedSourceIdentityLookup {
  readonly lookupCalls: string[][] = [];

  constructor(private readonly indexedAssetIds: string[]) {}

  async findIndexedAssetIdsForCanonicalAssets(assetIds: readonly string[]) {
    this.lookupCalls.push([...assetIds]);
    return this.indexedAssetIds;
  }
}

class FakeQueueEntryRepository implements QueueEntryRepository {
  readonly countCalls: string[][] = [];

  constructor(
    private readonly queueEntries: QueueEntry[],
    private readonly playCounts: Record<string, number>
  ) {}

  async findById() {
    return null;
  }

  async listEffectiveQueue() {
    return this.queueEntries;
  }

  async listUndoableRemoved() {
    return [];
  }

  async findCurrentForRoom() {
    return null;
  }

  async append() {
    return this.queueEntries[0] ?? createQueueEntry({ songId: "song-hot" });
  }

  async markRemoved() {
    return null;
  }

  async undoRemoved() {
    return null;
  }

  async renumberQueue() {
    return this.queueEntries;
  }

  async markCompleted() {
    return null;
  }

  async listGlobalSongRequestCounts(songIds: readonly string[]) {
    this.countCalls.push([...songIds]);
    return new Map(songIds.map((songId) => [songId, this.playCounts[songId] ?? 0]));
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

function createSearchRecord(input: {
  id: string;
  title: string;
  artistId: string;
  artistName: string;
  genre: string[];
  queueState?: "not_queued" | "queued";
}): SearchFormalSongRecord {
  return {
    song: {
      id: input.id,
      title: input.title,
      normalizedTitle: input.title,
      titlePinyin: "",
      titleInitials: "",
      artistId: input.artistId,
      artistName: input.artistName,
      language: "mandarin",
      status: "ready",
      genre: input.genre,
      tags: [],
      aliases: [],
      searchHints: [],
      releaseYear: null,
      canonicalDurationMs: 180000,
      searchWeight: 10,
      defaultAssetId: `asset-${input.id}`,
      capabilities: { canSwitchVocalMode: true },
      createdAt: now,
      updatedAt: now
    },
    matchReason: "default",
    score: 100,
    queueState: input.queueState ?? "not_queued",
    versions: [createVersion(`asset-${input.id}`)]
  };
}

function createVersion(assetId: string): SongSearchVersionOption {
  return {
    assetId,
    displayName: "本地版本",
    sourceType: "local",
    sourceLabel: "本地",
    durationMs: 180000,
    qualityLabel: "HD",
    isRecommended: true,
    queueState: "queueable",
    canQueue: true,
    disabledLabel: null
  };
}

function createIndexedResult(input: {
  indexedSongId: string;
  indexedAssetId: string;
  title: string;
  artistName: string;
  styleTags: string[];
  queueState?: "not_queued" | "queued" | "source_missing" | "file_unreadable";
}): SongSearchIndexedResult {
  const queueState = input.queueState ?? "not_queued";
  return {
    indexedSongId: input.indexedSongId,
    title: input.title,
    artistName: input.artistName,
    styleTags: input.styleTags,
    category: input.styleTags[0] ?? "未打标签",
    sourceLabel: "KTV索引",
    matchReason: "default",
    versions: [
      {
        indexedAssetId: input.indexedAssetId,
        displayName: `${input.artistName}-${input.title}.mkv`,
        sourceLabel: "KTV索引",
        extension: ".mkv",
        sizeBytes: 123456,
        audioTrackCount: 2,
        styleTags: input.styleTags,
        category: input.styleTags[0] ?? "未打标签",
        queueState,
        canQueue: queueState !== "file_unreadable" && queueState !== "source_missing",
        disabledLabel: queueState === "file_unreadable" ? "文件不可读" : null
      }
    ]
  };
}

function createQueueEntry(input: { songId: string; assetId?: string }): QueueEntry {
  return {
    id: `queue-${input.songId}`,
    roomId: "living-room",
    songId: input.songId,
    assetId: input.assetId ?? `asset-${input.songId}`,
    requestedBy: "control-session",
    queuePosition: 1,
    status: "queued",
    priority: 0,
    playbackOptions: {
      preferredVocalMode: null,
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
