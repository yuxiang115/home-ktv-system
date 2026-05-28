import type {
  AssetId,
  CompatibilityReason,
  CompatibilityStatus,
  MediaInfoProvenance,
  MediaInfoSummary,
  MediaSourceRef,
  PlaybackProfile,
  SongId,
  SongSourceType,
  TrackRoles
} from "@home-ktv/domain";

export type PlayableMediaStatus = "ready" | "unavailable" | "failed" | "stale";

export type PlayableMediaLookup = Pick<MediaSourceRef, "sourceType" | "assetId">;

export interface PlayableMediaAsset {
  sourceType: SongSourceType;
  songId: SongId;
  assetId: AssetId;
  title: string;
  artistName: string;
  displayName: string;
  filePath: string;
  status: PlayableMediaStatus;
  durationMs: number;
  compatibilityStatus: CompatibilityStatus;
  compatibilityReasons: readonly CompatibilityReason[];
  mediaInfoSummary: MediaInfoSummary;
  mediaInfoProvenance: MediaInfoProvenance;
  trackRoles: TrackRoles;
  playbackProfile: PlaybackProfile;
}

export interface PlayableMediaRepository {
  findPlayableBySource(source: PlayableMediaLookup): Promise<PlayableMediaAsset | null>;
}
