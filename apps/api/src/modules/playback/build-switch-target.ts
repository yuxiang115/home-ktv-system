import type { Asset, MediaSourceRef, QueueEntry, TrackRef } from "@home-ktv/domain";
import type { SwitchTarget } from "@home-ktv/player-contracts";
import type { AssetGateway } from "../assets/asset-gateway.js";
import type { AssetRepository } from "../catalog/repositories/asset-repository.js";
import type { MediaGateway } from "../media/media-gateway.js";
import type { PlayableMediaAsset, PlayableMediaRepository } from "../media/playable-media-repository.js";
import type { RoomRepository } from "../rooms/repositories/room-repository.js";
import type { PlaybackSessionRepository } from "./repositories/playback-session-repository.js";
import type { QueueEntryRepository } from "./repositories/queue-entry-repository.js";

export interface BuildSwitchTargetRepositories {
  rooms: RoomRepository;
  playbackSessions: PlaybackSessionRepository;
  queueEntries: QueueEntryRepository;
  assets: AssetRepository;
  playableMedia?: PlayableMediaRepository;
}

export interface BuildSwitchTargetInput {
  roomSlug: string;
  repositories: BuildSwitchTargetRepositories;
  assetGateway?: AssetGateway;
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

  if (input.repositories.playableMedia && input.mediaGateway) {
    return buildSourceSwitchTarget({
      roomId: room.id,
      sessionVersion: session.version,
      queueEntry,
      resumePositionMs: session.playerPositionMs,
      playableMedia: input.repositories.playableMedia,
      mediaGateway: input.mediaGateway
    });
  }

  const activeAssetId = session.activeAssetId ?? queueEntry.assetId;
  if (!input.assetGateway || !activeAssetId) {
    return null;
  }

  const currentAsset = await input.repositories.assets.findById(activeAssetId);

  if (!currentAsset) {
    return null;
  }

  if (isSingleFileRealMvAsset(currentAsset)) {
    return buildRealMvSwitchTarget({
      roomId: room.id,
      sessionVersion: session.version,
      queueEntry,
      currentAsset,
      resumePositionMs: session.playerPositionMs,
      assetGateway: input.assetGateway
    });
  }

  if (!currentAsset.switchFamily) {
    return null;
  }

  const counterparts = await input.repositories.assets.findVerifiedSwitchCounterparts(currentAsset);
  const verifiedCounterparts = counterparts.filter(
    (candidate) =>
      candidate.switchFamily === currentAsset.switchFamily &&
      candidate.vocalMode !== currentAsset.vocalMode &&
      candidate.status === "ready" &&
      candidate.switchQualityStatus === "verified"
  );

  if (verifiedCounterparts.length !== 1) {
    return null;
  }

  const targetAsset = verifiedCounterparts[0];
  if (!targetAsset?.switchFamily) {
    return null;
  }

  const selectedTrackRef = selectedTrackRefForAsset(targetAsset);

  return {
    roomId: room.id,
    sessionVersion: session.version,
    queueEntryId: queueEntry.id,
    switchKind: "asset",
    sourceType: queueEntry.source?.sourceType ?? "nas",
    fromAssetId: currentAsset.id,
    toAssetId: targetAsset.id,
    playbackUrl: input.assetGateway.createPlaybackUrl(targetAsset.id),
    switchFamily: targetAsset.switchFamily,
    vocalMode: targetAsset.vocalMode,
    rollbackAssetId: currentAsset.id,
    resumePositionMs: session.playerPositionMs,
    ...(targetAsset.playbackProfile ? { playbackProfile: targetAsset.playbackProfile } : {}),
    ...(selectedTrackRef ? { selectedTrackRef } : {})
  };
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
    playbackUrl: input.mediaGateway.createPlaybackUrl(source)
  });
}

function isSingleFileRealMvAsset(asset: Asset): boolean {
  return asset.playbackProfile?.kind === "single_file_audio_tracks" || asset.assetKind === "dual-track-video";
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

function selectedTrackRefForRealMvSwitch(asset: Asset, vocalMode: "original" | "instrumental"): TrackRef | null {
  return vocalMode === "original" ? asset.trackRoles?.original ?? null : asset.trackRoles?.instrumental ?? null;
}

function selectedTrackRefForAsset(asset: Asset): TrackRef | null {
  if (asset.vocalMode === "original") {
    return asset.trackRoles?.original ?? null;
  }
  if (asset.vocalMode === "instrumental") {
    return asset.trackRoles?.instrumental ?? null;
  }
  return null;
}

function buildRealMvSwitchTarget(input: {
  roomId: string;
  sessionVersion: number;
  queueEntry: QueueEntry;
  currentAsset: Asset;
  resumePositionMs: number;
  assetGateway: AssetGateway;
}): SwitchTarget | null {
  const targetMode = nextRealMvVocalMode(committedVocalModeForQueueEntry(input.queueEntry));
  const selectedTrackRef = selectedTrackRefForRealMvSwitch(input.currentAsset, targetMode);
  if (!selectedTrackRef) {
    return null;
  }

  return {
    roomId: input.roomId,
    sessionVersion: input.sessionVersion,
    queueEntryId: input.queueEntry.id,
    switchKind: "audio_track",
    sourceType: input.queueEntry.source?.sourceType ?? "nas",
    fromAssetId: input.currentAsset.id,
    toAssetId: input.currentAsset.id,
    playbackUrl: input.assetGateway.createPlaybackUrl(input.currentAsset.id),
    switchFamily: input.currentAsset.switchFamily ?? "real-mv-audio-track",
    vocalMode: targetMode,
    resumePositionMs: input.resumePositionMs,
    rollbackAssetId: input.currentAsset.id,
    ...(input.currentAsset.playbackProfile ? { playbackProfile: input.currentAsset.playbackProfile } : {}),
    selectedTrackRef
  };
}

function buildPlayableAudioTrackSwitchTarget(input: {
  roomId: string;
  sessionVersion: number;
  queueEntry: QueueEntry;
  asset: PlayableMediaAsset;
  resumePositionMs: number;
  playbackUrl: string;
}): SwitchTarget | null {
  const targetMode = nextRealMvVocalMode(committedVocalModeForQueueEntry(input.queueEntry));
  const selectedTrackRef = targetMode === "original" ? input.asset.trackRoles.original : input.asset.trackRoles.instrumental;
  if (!selectedTrackRef) {
    return null;
  }

  return {
    roomId: input.roomId,
    sessionVersion: input.sessionVersion,
    queueEntryId: input.queueEntry.id,
    switchKind: "audio_track",
    sourceType: input.asset.sourceType,
    fromAssetId: input.asset.assetId,
    toAssetId: input.asset.assetId,
    playbackUrl: input.playbackUrl,
    switchFamily: "real-mv-audio-track",
    vocalMode: targetMode,
    resumePositionMs: input.resumePositionMs,
    rollbackAssetId: input.asset.assetId,
    playbackProfile: input.asset.playbackProfile,
    selectedTrackRef
  };
}

function sourceRefFromQueueEntry(queueEntry: QueueEntry): MediaSourceRef {
  return queueEntry.source ?? {
    sourceType: "nas",
    songId: queueEntry.songId,
    assetId: queueEntry.assetId
  };
}
