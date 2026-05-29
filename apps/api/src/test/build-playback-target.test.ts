import type { PlaybackSession, QueueEntry, Room } from "@home-ktv/domain";
import { describe, expect, it } from "vitest";
import type { MediaGateway } from "../modules/media/media-gateway.js";
import type { PlayableMediaAsset, PlayableMediaLookup, PlayableMediaRepository } from "../modules/media/playable-media-repository.js";
import { buildPlaybackTarget, type BuildPlaybackTargetRepositories } from "../modules/playback/build-playback-target.js";

const now = "2026-04-28T00:00:00.000Z";

describe("buildPlaybackTarget", () => {
  it("builds a NAS playback target from queue source identity without activeAssetId", async () => {
    const room = createRoom("living-room");
    const current = createPlayableMediaAsset("ktv-song-current", "ktv-asset-current", "七里香", "周杰伦");
    const next = createPlayableMediaAsset("ktv-song-next", "ktv-asset-next", "后来", "刘若英");
    const repositories = createRepositories({
      room,
      session: createPlaybackSession(room.id),
      queueEntries: [
        createQueueEntry("queue-current", room.id, current.songId, current.assetId, "playing"),
        createQueueEntry("queue-next", room.id, next.songId, next.assetId, "queued")
      ],
      playableMedia: [current, next]
    });

    const target = await buildPlaybackTarget({
      roomSlug: "living-room",
      repositories,
      mediaGateway: createMediaGateway()
    });

    expect(target).toMatchObject({
      roomId: "living-room",
      sessionVersion: 11,
      queueEntryId: "queue-current",
      sourceType: "nas",
      songId: current.songId,
      assetId: current.assetId,
      playbackUrl: `http://ktv.local/media/nas/${current.assetId}`,
      vocalMode: "instrumental",
      currentQueueEntryPreview: {
        queueEntryId: "queue-current",
        songTitle: "七里香",
        artistName: "周杰伦"
      },
      nextQueueEntryPreview: {
        queueEntryId: "queue-next",
        songTitle: "后来",
        artistName: "刘若英"
      }
    });
  });

  it("uses queue playbackOptions to select the original NAS audio track", async () => {
    const room = createRoom("living-room");
    const current = createPlayableMediaAsset("ktv-song-current", "ktv-asset-current", "七里香", "周杰伦");
    const repositories = createRepositories({
      room,
      session: { ...createPlaybackSession(room.id), nextQueueEntryId: null },
      queueEntries: [
        createQueueEntry("queue-current", room.id, current.songId, current.assetId, "playing", {
          preferredVocalMode: "original"
        })
      ],
      playableMedia: [current]
    });

    const target = await buildPlaybackTarget({
      roomSlug: "living-room",
      repositories,
      mediaGateway: createMediaGateway()
    });

    expect(target).toMatchObject({
      assetId: current.assetId,
      vocalMode: "original",
      selectedTrackRef: { index: 0, id: "0x1100", label: "Original" },
      playbackProfile: { kind: "single_file_audio_tracks", requiresAudioTrackSelection: true }
    });
  });
});

interface RepositoryState {
  room: Room;
  session: PlaybackSession;
  queueEntries: QueueEntry[];
  playableMedia: PlayableMediaAsset[];
}

function createRepositories(state: RepositoryState): BuildPlaybackTargetRepositories {
  return {
    rooms: {
      findById: async (roomId) => (roomId === state.room.id ? state.room : null),
      findBySlug: async (slug) => (slug === state.room.slug ? state.room : null)
    },
    playbackSessions: {
      findByRoomId: async (roomId) => (roomId === state.room.id ? state.session : null),
      startQueueEntry: async () => state.session,
      setIdle: async () => state.session,
      requestSwitchTarget: async () => state.session
    },
    queueEntries: {
      findById: async (queueEntryId) => state.queueEntries.find((entry) => entry.id === queueEntryId) ?? null,
      listEffectiveQueue: async () => state.queueEntries,
      listUndoableRemoved: async () => [],
      findCurrentForRoom: async () => null,
      append: async () => state.queueEntries[0]!,
      markRemoved: async () => null,
      undoRemoved: async () => null,
      renumberQueue: async () => [],
      markCompleted: async () => null
    },
    playableMedia: new FakePlayableMediaRepository(state.playableMedia)
  };
}

function createMediaGateway(): Pick<MediaGateway, "createPlaybackUrl"> {
  return {
    createPlaybackUrl(source: PlayableMediaLookup) {
      return `http://ktv.local/media/${source.sourceType}/${source.assetId}`;
    }
  };
}

class FakePlayableMediaRepository implements PlayableMediaRepository {
  constructor(private readonly assets: readonly PlayableMediaAsset[]) {}

  async findPlayableBySource(source: PlayableMediaLookup): Promise<PlayableMediaAsset | null> {
    return this.assets.find((asset) => asset.sourceType === source.sourceType && asset.assetId === source.assetId) ?? null;
  }
}

function createRoom(slug: string): Room {
  return {
    id: slug,
    slug,
    name: "Living Room",
    status: "active",
    defaultPlayerDeviceId: null,
    createdAt: now,
    updatedAt: now
  };
}

function createPlaybackSession(roomId: string): PlaybackSession {
  return {
    roomId,
    currentQueueEntryId: "queue-current",
    nextQueueEntryId: "queue-next",
    activeAssetId: null,
    targetVocalMode: "instrumental",
    playerState: "playing",
    playerPositionMs: 45678,
    mediaStartedAt: now,
    version: 11,
    updatedAt: now
  };
}

function createQueueEntry(
  id: string,
  roomId: string,
  songId: string,
  assetId: string,
  status: QueueEntry["status"],
  playbackOptions: Partial<QueueEntry["playbackOptions"]> = {}
): QueueEntry {
  return {
    id,
    roomId,
    source: { sourceType: "nas", songId, assetId },
    songId,
    assetId,
    requestedBy: "mobile",
    queuePosition: id === "queue-current" ? 1 : 2,
    status,
    priority: 0,
    playbackOptions: {
      preferredVocalMode: "instrumental",
      pitchSemitones: 0,
      requireReadyAsset: true,
      ...playbackOptions
    },
    requestedAt: now,
    startedAt: status === "playing" ? now : null,
    endedAt: null,
    removedAt: null,
    removedByControlSessionId: null,
    undoExpiresAt: null
  };
}

function createPlayableMediaAsset(
  songId: string,
  assetId: string,
  title: string,
  artistName: string
): PlayableMediaAsset {
  return {
    sourceType: "nas",
    songId,
    assetId,
    title,
    artistName,
    displayName: title,
    filePath: `/nas/${assetId}.mp4`,
    status: "ready",
    durationMs: 180000,
    compatibilityStatus: "playable",
    compatibilityReasons: [],
    mediaInfoSummary: {
      container: "mp4",
      durationMs: 180000,
      videoCodec: "h264",
      resolution: { width: 1920, height: 1080 },
      fileSizeBytes: 1000,
      audioTracks: [
        { index: 0, id: "0x1100", label: "Original", language: "zh", codec: "aac", channels: 2 },
        { index: 1, id: "0x1101", label: "Instrumental", language: "zh", codec: "aac", channels: 2 }
      ]
    },
    mediaInfoProvenance: { source: "ffprobe", sourceVersion: null, probedAt: now, importedFrom: `/nas/${assetId}.mp4` },
    trackRoles: {
      original: { index: 0, id: "0x1100", label: "Original" },
      instrumental: { index: 1, id: "0x1101", label: "Instrumental" }
    },
    playbackProfile: {
      kind: "single_file_audio_tracks",
      container: "mp4",
      videoCodec: "h264",
      audioCodecs: ["aac"],
      requiresAudioTrackSelection: true
    }
  };
}
