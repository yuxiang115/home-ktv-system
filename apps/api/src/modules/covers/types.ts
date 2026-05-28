import type { SongDiscoverySource } from "@home-ktv/domain";

export type SongCoverSource = SongDiscoverySource;
export type SongCoverStatus = "pending" | "found" | "not_found" | "failed";

export interface SongCoverLookupKey {
  source: SongCoverSource;
  sourceSongId: string;
}

export interface SongCoverCacheEntry extends SongCoverLookupKey {
  imageUrl: string;
  provider: string;
  providerSongId: string | null;
  confidence: number;
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

export function songCoverCacheKey(key: SongCoverLookupKey): string {
  return `${key.source}:${key.sourceSongId}`;
}
