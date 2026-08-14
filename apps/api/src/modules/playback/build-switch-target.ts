import type { MediaSourceRef, QueueEntry, TrackRef } from "@home-ktv/domain";
import type { SwitchTarget } from "@home-ktv/player-contracts";
import type { MediaGateway } from "../media/media-gateway.js";
import type { PlayableMediaAsset, PlayableMediaRepository } from "../media/playable-media-repository.js";
import type { RoomRepository } from "../rooms/repositories/room-repository.js";
import type { PlaybackSessionRepository } from "./repositories/playback-session-repository.js";
import type { QueueEntryRepository } from "./repositories/queue-entry-repository.js";

export interface BuildSwitchTargetRepositories {
  rooms: RoomRepository;
  playbackSessions: PlaybackSessionRepository;
  queueEntries: QueueEntryRepository;
  playableMedia?: PlayableMediaRepository;
}

export interface BuildSwitchTargetInput {
  roomSlug: string;
  repositories: BuildSwitchTargetRepositories;
  mediaGateway?: Pick<MediaGateway, "createPlaybackUrl">;
}

export async function buildSwitchTarget(input: BuildSwitchTargetInput): Promise<SwitchTarget | null> {
  const room = await input.repositories.rooms.findBySlug(input.roomSlug);
  if (!room) {
    return null;
  }

  const session = await input.repositories.playbackSessions.findByRoomId(room.id);
  if (!session?.currentQueueEntryId) {
    return null;
  }

  const queueEntry = await input.repositories.queueEntries.findById(session.currentQueueEntryId);
  if (!queueEntry) {
    return null;
  }

  if (!input.repositories.playableMedia || !input.mediaGateway) {
    return null;
  }

  return buildSourceSwitchTarget({
    roomId: room.id,
    sessionVersion: session.version,
    resumePositionMs: session.playerPositionMs,
    queueEntry,
    playableMedia: input.repositories.playableMedia,
    mediaGateway: input.mediaGateway
  });
}

async function buildSourceSwitchTarget(input: {
  roomId: string;
  sessionVersion: number;
  queueEntry: QueueEntry;
  resumePositionMs: number;
  playableMedia: PlayableMediaRepository;
  mediaGateway: Pick<MediaGateway, "createPlaybackUrl">;
}): Promise<SwitchTarget | null> {
  const source = sourceRefFromQueueEntry(input.queueEntry);
  const asset = await input.playableMedia.findPlayableBySource(source);
  if (!asset || asset.status !== "ready" || asset.playbackProfile.kind !== "single_file_audio_tracks") {
    return null;
  }

  return buildPlayableAudioTrackSwitchTarget({
    roomId: input.roomId,
    sessionVersion: input.sessionVersion,
    queueEntry: input.queueEntry,
    asset,
    resumePositionMs: input.resumePositionMs,
    playbackUrl: input.mediaGateway.createPlaybackUrl(source),
    mediaGateway: input.mediaGateway,
    source
  });
}

function committedVocalModeForQueueEntry(queueEntry: QueueEntry): "original" | "instrumental" {
  const preferredVocalMode = queueEntry.playbackOptions.preferredVocalMode;
  return preferredVocalMode === "original" || preferredVocalMode === "instrumental"
    ? preferredVocalMode
    : "instrumental";
}

function nextRealMvVocalMode(current: "original" | "instrumental"): "original" | "instrumental" {
  return current === "original" ? "instrumental" : "original";
}

function buildPlayableAudioTrackSwitchTarget(input: {
  roomId: string;
  sessionVersion: number;
  queueEntry: QueueEntry;
  asset: PlayableMediaAsset;
  resumePositionMs: number;
  playbackUrl: string;
  mediaGateway: Pick<MediaGateway, "createPlaybackUrl">;
  source: ReturnType<typeof sourceRefFromQueueEntry>;
}): SwitchTarget | null {
  const targetMode = nextRealMvVocalMode(committedVocalModeForQueueEntry(input.queueEntry));
  const selectedTrackRef = targetMode === "original" ? input.asset.trackRoles.original : input.asset.trackRoles.instrumental;
  if (!selectedTrackRef) {
    return null;
  }

  // Chromium 系浏览器没有 video.audioTracks,单文件切轨必然失败;附一个 remux 选轨流
  // 的兜底地址,TV 端检测到不支持时用 standby 视频池整流切换(视频相同、音轨为目标轨)。
  const audioTrackPos = audioTrackPosForTrackRef(input.asset, selectedTrackRef);
  const fallbackPlaybackUrl = audioTrackPos !== null
    ? input.mediaGateway.createPlaybackUrl(input.source, {
        audioTrackPos,
        startMs: input.resumePositionMs
      })
    : null;

  return {
    roomId: input.roomId,
    sessionVersion: input.sessionVersion,
    queueEntryId: input.queueEntry.id,
    switchKind: "audio_track",
    sourceType: input.asset.sourceType,
    fromAssetId: input.asset.assetId,
    toAssetId: input.asset.assetId,
    playbackUrl: input.playbackUrl,
    fallbackPlaybackUrl,
    switchFamily: "real-mv-audio-track",
    vocalMode: targetMode,
    resumePositionMs: input.resumePositionMs,
    rollbackAssetId: input.asset.assetId,
    playbackProfile: input.asset.playbackProfile,
    selectedTrackRef
  };
}

// TrackRef.index 是 ffprobe 的全局流 index(含视频轨);ffmpeg -map 0:a:N 需要的是
// 音频轨自身序号,用 id/label 反查在 audioTracks 数组中的位置。
export function audioTrackPosForTrackRef(
  asset: Pick<PlayableMediaAsset, "mediaInfoSummary">,
  trackRef: TrackRef | null | undefined
): number | null {
  if (!trackRef) {
    return null;
  }
  const tracks = asset.mediaInfoSummary.audioTracks;
  const byId = tracks.findIndex((track) => track.id === trackRef.id);
  if (byId >= 0) {
    return byId;
  }
  const byIndex = tracks.findIndex((track) => track.index === trackRef.index);
  if (byIndex >= 0) {
    return byIndex;
  }
  const label = trackRef.label.trim().toLocaleLowerCase();
  if (label) {
    const byLabel = tracks.findIndex(
      (track) => track.label.toLocaleLowerCase().includes(label)
    );
    if (byLabel >= 0) {
      return byLabel;
    }
  }
  return null;
}

function sourceRefFromQueueEntry(queueEntry: QueueEntry): MediaSourceRef {
  return queueEntry.source ?? {
    sourceType: "nas",
    songId: queueEntry.songId,
    assetId: queueEntry.assetId
  };
}
