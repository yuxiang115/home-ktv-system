import Fastify from "fastify";
import type { QueueEntry, Room, SongSearchIndexedResult } from "@home-ktv/domain";
import { describe, expect, it } from "vitest";
import type { KtvIndexReadRepository, SearchKtvIndexedSongsInput } from "../modules/ktv-index/ktv-index-read-repository.js";
import type { QueueEntryRepository } from "../modules/playback/repositories/queue-entry-repository.js";
import type { RoomRepository } from "../modules/rooms/repositories/room-repository.js";
import { registerSongSearchRoutes } from "../routes/song-search.js";

const now = "2026-05-28T10:00:00.000Z";

describe("song search routes", () => {
  it("returns ROOM_NOT_FOUND for missing rooms", async () => {
    const { server } = await createHarness({ room: null });

    const response = await server.inject({
      method: "GET",
      url: "/rooms/missing/songs/search?q=七里香"
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: "ROOM_NOT_FOUND" });
  });

  it("returns NAS search results and hides formal/indexed response sections", async () => {
    const ktvIndex = new FakeKtvIndexReadRepository([
      createIndexedSearchResult({
        indexedSongId: "ktv-song-qilixiang",
        versions: [
          {
            indexedAssetId: "ktv-asset-qilixiang-main",
            displayName: "七里香 - 周杰伦.mkv",
            sourceLabel: "KTV索引",
            extension: ".mkv",
            sizeBytes: 734003200,
            audioTrackCount: 2,
            category: "流行",
            queueState: "not_queued",
            canQueue: true,
            disabledLabel: null
          }
        ]
      })
    ]);
    const { server } = await createHarness({
      ktvIndex,
      queueEntries: [createQueueEntry({ songId: "ktv-song-qilixiang", assetId: "ktv-asset-qilixiang-main" })]
    });

    const response = await server.inject({
      method: "GET",
      url: "/rooms/living-room/songs/search?q=%E4%B8%83%E9%87%8C%E9%A6%99&limit=999"
    });

    expect(response.statusCode).toBe(200);
    expect(ktvIndex.searchCalls).toEqual([
      {
        query: "七里香",
        limit: 20,
        versionsPerSong: 4,
        queuedIndexedAssetIds: ["ktv-asset-qilixiang-main"],
        unreadableIndexedAssetIds: []
      }
    ]);
    const body = response.json();
    expect(body).not.toHaveProperty("local");
    expect(body).not.toHaveProperty("indexed");
    expect(body.nas).toEqual({
      status: "available",
      message: "找到 NAS 曲库结果",
      results: [
        {
          songId: "ktv-song-qilixiang",
          title: "七里香",
          artistName: "周杰伦",
          category: "流行",
          sourceLabel: "NAS曲库",
          matchReason: "title",
          versions: [
            {
              assetId: "ktv-asset-qilixiang-main",
              displayName: "七里香 - 周杰伦.mkv",
              sourceLabel: "NAS曲库",
              extension: ".mkv",
              sizeBytes: 734003200,
              audioTrackCount: 2,
              category: "流行",
              queueState: "queued",
              canQueue: true,
              disabledLabel: null
            }
          ]
        }
      ]
    });
    expect(JSON.stringify(body)).not.toContain(["", "mnt", "nas"].join("/"));
    expect(JSON.stringify(body)).not.toContain(["file", "path"].join("_"));
  });

  it("keeps online supplement disabled when NAS search is empty", async () => {
    const { server } = await createHarness({ ktvIndex: new FakeKtvIndexReadRepository([]) });

    const response = await server.inject({
      method: "GET",
      url: "/rooms/living-room/songs/search?q=%E6%B2%A1%E6%9C%89%E7%9A%84%E6%AD%8C"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      nas: { status: "unavailable", message: "未找到 NAS 曲库结果", results: [] },
      online: {
        status: "disabled",
        message: "暂不启用线上补歌",
        requestSupplement: { visible: false, label: "请求补歌" },
        candidates: []
      }
    });
  });
});

async function createHarness(input: {
  room?: Room | null;
  ktvIndex?: KtvIndexReadRepository;
  queueEntries?: readonly QueueEntry[];
} = {}) {
  const server = Fastify();
  await registerSongSearchRoutes(server, {
    rooms: new FakeRoomRepository(input.room === undefined ? createRoom() : input.room),
    queueEntries: new FakeQueueEntryRepository(input.queueEntries ?? []),
    ...(input.ktvIndex ? { ktvIndex: input.ktvIndex } : {})
  });
  await server.ready();
  return { server };
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
  constructor(private readonly queueEntries: readonly QueueEntry[]) {}

  async listEffectiveQueue(): Promise<QueueEntry[]> {
    return this.queueEntries.map((entry) => ({ ...entry }));
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

function createIndexedSearchResult(input: Partial<SongSearchIndexedResult> = {}): SongSearchIndexedResult {
  return {
    indexedSongId: "ktv-song-qilixiang",
    title: "七里香",
    artistName: "周杰伦",
    category: "流行",
    sourceLabel: "KTV索引",
    matchReason: "title",
    versions: [
      {
        indexedAssetId: "ktv-asset-qilixiang-main",
        displayName: "七里香 - 周杰伦.mkv",
        sourceLabel: "KTV索引",
        extension: ".mkv",
        sizeBytes: 734003200,
        audioTrackCount: 2,
        category: "流行",
        queueState: "not_queued",
        canQueue: true,
        disabledLabel: null
      }
    ],
    ...input
  };
}
