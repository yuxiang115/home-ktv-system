import type { AssetId, MediaSourceRef, SongId, SongSourceType } from "@home-ktv/domain";

export function createMediaSourceRef(input: {
  sourceType: SongSourceType;
  songId: SongId;
  assetId: AssetId;
}): MediaSourceRef {
  return {
    sourceType: input.sourceType,
    songId: input.songId,
    assetId: input.assetId
  };
}

export function mediaSourceKey(source: Pick<MediaSourceRef, "sourceType" | "assetId">): string {
  return `${source.sourceType}:${source.assetId}`;
}
