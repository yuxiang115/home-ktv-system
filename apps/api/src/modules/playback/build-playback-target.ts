import type { Asset, MediaSourceRef, PlaybackProfile, QueueEntry, Room, Song, TrackRef, VocalMode } from "@home-ktv/domain";
import type { PlaybackTarget, QueueEntryPreview } from "@home-ktv/player-contracts";
import type { AssetGateway } from "../assets/asset-gateway.js";
import type { AssetRepository } from "../catalog/repositories/asset-repository.js";
import type { SongRepository } from "../catalog/repositories/song-repository.js";
import type { MediaGateway } from "../media/media-gateway.js";
import type { PlayableMediaAsset, PlayableMediaRepository } from "../media/playable-media-repository.js";
import type { RoomRepository } from "../rooms/repositories/room-repository.js";
import type { PlaybackSessionRepository } from "./repositories/playback-session-repository.js";
import type { QueueEntryRepository } from "./repositories/queue-entry-repository.js";

export interface BuildPlaybackTargetRepositories {
  rooms: RoomRepository;
  playbackSessions: PlaybackSessionRepository;
  queueEntries: QueueEntryRepository;
  assets: AssetRepository;
  songs: SongRepository;
  playableMedia?: PlayableMediaRepository;
}

export interface BuildPlaybackTargetInput {
  roomSlug: string;
  repositories: BuildPlaybackTargetRepositories;
  assetGateway?: AssetGateway;
  mediaGateway?: Pick<MediaGateway, "createPlaybackUrl">;
}

export async function buildPlaybackTarget(input: BuildPlaybackTargetInput): Promise<PlaybackTarget | null> {
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

  if (input.repositories.playableMedia && input.mediaGateway) {
    return buildSourcePlaybackTarget({ ...input, room, queueEntry, sessionVersion: session.version, resumePositionMs: session.playerPositionMs, nextQueueEntryId: session.nextQueueEntryId });
  }

  const activeAssetId = session.activeAssetId ?? queueEntry.assetId;
  if (!input.assetGateway || !activeAssetId) {
    return null;
  }

  const asset = await input.repositories.assets.findById(activeAssetId);

  if (!asset || asset.status !== "ready") {
    return null;
  }

  const currentSong = await input.repositories.songs.findById(queueEntry.songId);
  if (!currentSong) {
    return null;
  }

  const effectiveVocalMode = effectiveVocalModeForPlayback(asset, queueEntry);

  return {
    roomId: room.id,
    sessionVersion: session.version,
    queueEntryId: queueEntry.id,
    sourceType: queueEntry.source?.sourceType ?? "nas",
    songId: queueEntry.songId,
    assetId: asset.id,
    currentQueueEntryPreview: queuePreview(queueEntry, currentSong),
    playbackUrl: input.assetGateway.createPlaybackUrl(asset.id),
    resumePositionMs: session.playerPositionMs,
    vocalMode: effectiveVocalMode,
    switchFamily: asset.switchFamily,
    playbackProfile: buildPlaybackProfileForAsset(asset),
    selectedTrackRef: selectedTrackRefForResolvedMode(asset, effectiveVocalMode),
    nextQueueEntryPreview: await buildNextQueueEntryPreview(room, session.nextQueueEntryId, input.repositories)
  };
}

async function buildSourcePlaybackTarget(input: BuildPlaybackTargetInput & {
  room: Room;
  queueEntry: QueueEntry;
  sessionVersion: number;
  resumePositionMs: number;
  nextQueueEntryId: string | null;
}): Promise<PlaybackTarget | null> {
  const source = sourceRefFromQueueEntry(input.queueEntry);
  const asset = await input.repositories.playableMedia?.findPlayableBySource(source);
  if (!asset || asset.status !== "ready" || !input.mediaGateway) {
    return null;
  }

  const effectiveVocalMode = effectiveVocalModeForPlayableMedia(asset, input.queueEntry);

  return {
    roomId: input.room.id,
    sessionVersion: input.sessionVersion,
    queueEntryId: input.queueEntry.id,
    sourceType: asset.sourceType,
    songId: asset.songId,
    assetId: asset.assetId,
    currentQueueEntryPreview: queuePreviewFromPlayableMedia(input.queueEntry, asset),
    playbackUrl: input.mediaGateway.createPlaybackUrl(source),
    resumePositionMs: input.resumePositionMs,
    vocalMode: effectiveVocalMode,
    switchFamily: switchFamilyForPlayableMedia(asset),
    playbackProfile: asset.playbackProfile,
    selectedTrackRef: selectedTrackRefForPlayableMedia(asset, effectiveVocalMode),
    nextQueueEntryPreview: await buildNextQueueEntryPreview(input.room, input.nextQueueEntryId, input.repositories)
  };
}

function buildPlaybackProfileForAsset(asset: Asset): PlaybackProfile {
  if (asset.playbackProfile) {
    return asset.playbackProfile;
  }

  return {
    kind: "separate_asset_pair",
    container: asset.mediaInfoSummary?.container ?? null,
    videoCodec: asset.mediaInfoSummary?.videoCodec ?? null,
    audioCodecs: asset.mediaInfoSummary?.audioTracks.map((track) => track.codec).filter((codec): codec is string => Boolean(codec)) ?? [],
    requiresAudioTrackSelection: false
  };
}

function effectiveVocalModeForPlayback(asset: Asset, queueEntry: QueueEntry): VocalMode {
  if (asset.playbackProfile?.kind === "single_file_audio_tracks" || asset.assetKind === "dual-track-video") {
    return queueEntry.playbackOptions.preferredVocalMode ?? "instrumental";
  }

  return asset.vocalMode;
}

function selectedTrackRefForResolvedMode(asset: Asset, vocalMode: VocalMode): TrackRef | null {
  if (vocalMode === "original") {
    return asset.trackRoles?.original ?? null;
  }
  if (vocalMode === "instrumental") {
    return asset.trackRoles?.instrumental ?? null;
  }
  return null;
}

async function buildNextQueueEntryPreview(
  _room: Room,
  nextQueueEntryId: string | null,
  repositories: BuildPlaybackTargetRepositories
): Promise<QueueEntryPreview | null> {
  if (!nextQueueEntryId) {
    return null;
  }

  const nextQueueEntry = await repositories.queueEntries.findById(nextQueueEntryId);
  if (!nextQueueEntry) {
    return null;
  }

  if (repositories.playableMedia) {
    const nextAsset = await repositories.playableMedia.findPlayableBySource(sourceRefFromQueueEntry(nextQueueEntry));
    if (nextAsset) {
      return queuePreviewFromPlayableMedia(nextQueueEntry, nextAsset);
    }
  }

  const nextSong = await repositories.songs.findById(nextQueueEntry.songId);
  if (!nextSong) {
    return null;
  }

  return queuePreview(nextQueueEntry, nextSong);
}

function queuePreviewFromPlayableMedia(queueEntry: QueueEntry, asset: PlayableMediaAsset): QueueEntryPreview {
  return {
    queueEntryId: queueEntry.id,
    songTitle: asset.title,
    artistName: asset.artistName
  };
}

function queuePreview(queueEntry: QueueEntry, song: Song): QueueEntryPreview {
  return {
    queueEntryId: queueEntry.id,
    songTitle: song.title,
    artistName: song.artistName
  };
}

function sourceRefFromQueueEntry(queueEntry: QueueEntry): MediaSourceRef {
  return queueEntry.source ?? {
    sourceType: "nas",
    songId: queueEntry.songId,
    assetId: queueEntry.assetId
  };
}

function effectiveVocalModeForPlayableMedia(asset: PlayableMediaAsset, queueEntry: QueueEntry): VocalMode {
  if (asset.playbackProfile.kind === "single_file_audio_tracks") {
    return queueEntry.playbackOptions.preferredVocalMode ?? "instrumental";
  }
  return queueEntry.playbackOptions.preferredVocalMode ?? "instrumental";
}

function selectedTrackRefForPlayableMedia(asset: PlayableMediaAsset, vocalMode: VocalMode): TrackRef | null {
  if (vocalMode === "original") {
    return asset.trackRoles.original;
  }
  if (vocalMode === "instrumental") {
    return asset.trackRoles.instrumental;
  }
  return null;
}

function switchFamilyForPlayableMedia(asset: PlayableMediaAsset): string | null {
  return asset.playbackProfile.kind === "single_file_audio_tracks" &&
    Boolean(asset.trackRoles.original) &&
    Boolean(asset.trackRoles.instrumental)
    ? "real-mv-audio-track"
    : null;
}

export function buildPlaybackTargetFromResolvedState(input: {
  room: Room;
  queueEntry: QueueEntry;
  asset: Asset;
  sessionVersion: number;
  resumePositionMs: number;
  playbackUrl: string;
  nextQueueEntryPreview: QueueEntryPreview | null;
}): PlaybackTarget {
  const effectiveVocalMode = effectiveVocalModeForPlayback(input.asset, input.queueEntry);

  return {
    roomId: input.room.id,
    sessionVersion: input.sessionVersion,
    queueEntryId: input.queueEntry.id,
    sourceType: input.queueEntry.source?.sourceType ?? "nas",
    songId: input.queueEntry.songId,
    assetId: input.asset.id,
    currentQueueEntryPreview: input.nextQueueEntryPreview?.queueEntryId === input.queueEntry.id
      ? input.nextQueueEntryPreview
      : {
          queueEntryId: input.queueEntry.id,
          songTitle: input.asset.displayName,
          artistName: ""
        },
    playbackUrl: input.playbackUrl,
    resumePositionMs: input.resumePositionMs,
    vocalMode: effectiveVocalMode,
    switchFamily: input.asset.switchFamily,
    playbackProfile: buildPlaybackProfileForAsset(input.asset),
    selectedTrackRef: selectedTrackRefForResolvedMode(input.asset, effectiveVocalMode),
    nextQueueEntryPreview: input.nextQueueEntryPreview
  };
}
