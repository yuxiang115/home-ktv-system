import type { SongSourceType } from "@home-ktv/domain";

export type SongCoverSource = SongSourceType;
export type SongCoverStatus = "pending" | "found" | "not_found" | "failed";

export interface SongCoverLookupKey {
  source: SongCoverSource;
  sourceSongId: string;
}

export interface SongCoverEntry extends SongCoverLookupKey {
  imageUrl: string;
}

export interface SongCoverBackfillCandidate extends SongCoverLookupKey {
  title: string;
  artistName: string;
}

export interface SongCoverProviderResult {
  provider: string;
  providerSongId: string;
  title: string;
  artistNames: readonly string[];
  albumName: string;
  imageUrl: string;
  confidence: number;
  payload: Record<string, unknown>;
}

export interface SongCoverProvider {
  findCover(song: SongCoverBackfillCandidate): Promise<SongCoverProviderResult | null>;
}

export function songCoverKey(key: SongCoverLookupKey): string {
  return `${key.source}:${key.sourceSongId}`;
}
