import Fastify from "fastify";
import type {
  QueueEntry,
  Room,
  SongDiscoveryResponse,
  SongDiscoverySource,
  SongSearchIndexedResult,
  SongSearchVersionOption
} from "@home-ktv/domain";
import type { SongCoverCacheRepository } from "../modules/covers/song-cover-cache-repository.js";
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

  it("attaches cached cover image urls to discovery songs", async () => {
    const { server, coverCache } = await createHarness({
      searchResults: [
        createSearchRecord({ id: "song-hot", title: "晴天", artistId: "artist-jay", artistName: "周杰伦", genre: ["流行"] }),
        createSearchRecord({ id: "song-rock", title: "倔强", artistId: "artist-mayday", artistName: "五月天", genre: ["摇滚"] })
      ],
      coverEntries: {
        "formal:song-hot": "https://cover.example/jay-qingtian.jpg"
      }
    });

    const response = await server.inject({
      method: "GET",
      url: "/rooms/living-room/songs/discovery?seed=covers&limit=2"
    });

    expect(response.statusCode).toBe(200);
    expect(coverCache.lookupCalls).toEqual([
      [
        { source: "formal", sourceSongId: "song-hot" },
        { source: "formal", sourceSongId: "song-rock" }
      ]
    ]);

    const body = response.json<SongDiscoveryResponse>();
    const coveredSong = body.recommended.find((song) => song.songId === "song-hot");
    const uncoveredSong = body.recommended.find((song) => song.songId === "song-rock");
    expect(coveredSong?.coverImageUrl).toBe("https://cover.example/jay-qingtian.jpg");
    expect(uncoveredSong?.coverImageUrl).toBeUndefined();
    expect(body.artists.flatMap((artist) => artist.songs).find((song) => song.songId === "song-hot")?.coverImageUrl).toBe(
      "https://cover.example/jay-qingtian.jpg"
    );
    expect(body.genres.flatMap((genre) => genre.songs).find((song) => song.songId === "song-hot")?.coverImageUrl).toBe(
      "https://cover.example/jay-qingtian.jpg"
    );
  });

  it("surfaces covered songs in recommendations when weighted selection misses them", async () => {
    const { server } = await createHarness({
      searchResults: [
        createSearchRecord({ id: "song-1", title: "歌曲1", artistId: "artist-a", artistName: "歌手A", genre: ["流行"] }),
        createSearchRecord({ id: "song-2", title: "歌曲2", artistId: "artist-b", artistName: "歌手B", genre: ["流行"] }),
        createSearchRecord({ id: "song-3", title: "歌曲3", artistId: "artist-c", artistName: "歌手C", genre: ["流行"] }),
        createSearchRecord({ id: "song-4", title: "歌曲4", artistId: "artist-d", artistName: "歌手D", genre: ["流行"] }),
        createSearchRecord({ id: "song-5", title: "歌曲5", artistId: "artist-e", artistName: "歌手E", genre: ["流行"] }),
        createSearchRecord({ id: "song-6", title: "歌曲6", artistId: "artist-f", artistName: "歌手F", genre: ["流行"] }),
        createSearchRecord({ id: "song-7", title: "歌曲7", artistId: "artist-g", artistName: "歌手G", genre: ["流行"] }),
        createSearchRecord({ id: "song-8", title: "歌曲8", artistId: "artist-h", artistName: "歌手H", genre: ["流行"] })
      ],
      coverEntries: {
        "formal:song-2": "https://cover.example/song-2.jpg",
        "formal:song-3": "https://cover.example/song-3.jpg"
      }
    });

    const response = await server.inject({
      method: "GET",
      url: "/rooms/living-room/songs/discovery?seed=covers-surface&limit=3"
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<SongDiscoveryResponse>();
    expect(body.recommended).toHaveLength(3);
    expect(body.recommended.map((song) => song.songId)).toEqual(expect.arrayContaining(["song-2", "song-3"]));
    expect(body.recommended.filter((song) => song.coverImageUrl).map((song) => song.songId)).toEqual(["song-2", "song-3"]);
  });

  it("uses indexed song ids when looking up cached KTV index covers", async () => {
    const { server, coverCache } = await createHarness({
      searchResults: [],
      indexedResults: [
        createIndexedResult({
          indexedSongId: "indexed-qingtian",
          indexedAssetId: "indexed-asset-qingtian",
          title: "晴天",
          artistName: "周杰伦",
          styleTags: ["流行"]
        })
      ],
      coverEntries: {
        "ktv-index:indexed-qingtian": "https://cover.example/indexed-qingtian.jpg"
      }
    });

    const response = await server.inject({
      method: "GET",
      url: "/rooms/living-room/songs/discovery?seed=indexed-covers&limit=1"
    });

    expect(response.statusCode).toBe(200);
    expect(coverCache.lookupCalls).toEqual([[{ source: "ktv-index", sourceSongId: "indexed-qingtian" }]]);
    expect(response.json<SongDiscoveryResponse>().recommended[0]).toMatchObject({
      indexedSongId: "indexed-qingtian",
      coverImageUrl: "https://cover.example/indexed-qingtian.jpg"
    });
  });
});

async function createHarness(input: {
  room?: Room | null;
  searchResults?: SearchFormalSongRecord[];
  indexedResults?: SongSearchIndexedResult[];
  indexedAssetIdsForCanonicalAssets?: string[];
  queueEntries?: QueueEntry[];
  playCounts?: Record<string, number>;
  coverEntries?: Record<string, string>;
} = {}) {
  const server = Fastify({ logger: false });
  const rooms = new FakeRoomRepository(input.room === undefined ? createRoom() : input.room);
  const songs = new FakeSongRepository(input.searchResults ?? []);
  const ktvIndex = new FakeKtvIndexReadRepository(input.indexedResults ?? []);
  const indexedSources = new FakeIndexedSourceIdentityLookup(input.indexedAssetIdsForCanonicalAssets ?? []);
  const queueEntries = new FakeQueueEntryRepository(input.queueEntries ?? [], input.playCounts ?? {});
  const coverCache = new FakeSongCoverCacheRepository(input.coverEntries ?? {});

  await registerSongDiscoveryRoutes(server, {
    rooms,
    songs,
    queueEntries,
    ktvIndex,
    indexedSources,
    coverCache
  });

  return { server, rooms, songs, ktvIndex, indexedSources, queueEntries, coverCache };
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

class FakeSongCoverCacheRepository implements Pick<SongCoverCacheRepository, "findBySongKeys"> {
  readonly lookupCalls: Array<Array<{ source: SongDiscoverySource; sourceSongId: string }>> = [];

  constructor(private readonly entries: Record<string, string>) {}

  async findBySongKeys(keys: readonly { source: SongDiscoverySource; sourceSongId: string }[]) {
    this.lookupCalls.push(keys.map((key) => ({ source: key.source, sourceSongId: key.sourceSongId })));
    return new Map(
      keys
        .map((key) => {
          const imageUrl = this.entries[`${key.source}:${key.sourceSongId}`];
          return imageUrl
            ? [
                `${key.source}:${key.sourceSongId}`,
                {
                  source: key.source,
                  sourceSongId: key.sourceSongId,
                  imageUrl,
                  provider: "test-provider",
                  providerSongId: null,
                  confidence: 100
                }
              ]
            : null;
        })
        .filter(
          (
            entry
          ): entry is [
            string,
            {
              source: SongDiscoverySource;
              sourceSongId: string;
              imageUrl: string;
              provider: string;
              providerSongId: null;
              confidence: number;
            }
          ] => Boolean(entry)
        )
    );
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
