import type { SongSourceType } from "@home-ktv/domain";

export type SongCoverSource = SongSourceType;

export interface SongCoverLookupKey {
  source: SongCoverSource;
  sourceSongId: string;
}

export interface SongCoverEntry extends SongCoverLookupKey {
  imageUrl: string;
}

export function songCoverKey(key: SongCoverLookupKey): string {
  return `${key.source}:${key.sourceSongId}`;
}
