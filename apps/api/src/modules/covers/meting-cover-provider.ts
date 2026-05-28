import Meting from "@meting/core";
import { selectBestCoverCandidate, type CoverCandidate } from "./cover-matcher.js";
import type { SongCoverBackfillCandidate, SongCoverProvider, SongCoverProviderResult } from "./types.js";

export type MetingProviderId = "tencent" | "kugou" | "netease" | "kuwo" | "baidu";

export interface MetingCoverProviderOptions {
  providers?: readonly MetingProviderId[];
  imageSize?: number;
  searchLimit?: number;
  requestTimeoutMs?: number;
}

interface MetingSongPayload {
  id?: string | number;
  name?: string;
  artist?: readonly string[] | string;
  album?: string;
  pic_id?: string | number;
  source?: string;
}

const defaultProviders: readonly MetingProviderId[] = ["tencent", "kugou", "netease", "kuwo"];

export class MetingCoverProvider implements SongCoverProvider {
  private readonly providers: readonly MetingProviderId[];
  private readonly imageSize: number;
  private readonly requestTimeoutMs: number;
  private readonly searchLimit: number;

  constructor(options: MetingCoverProviderOptions = {}) {
    this.providers = options.providers ?? defaultProviders;
    this.imageSize = options.imageSize ?? 300;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 8000;
    this.searchLimit = options.searchLimit ?? 8;
  }

  async findCover(song: SongCoverBackfillCandidate): Promise<SongCoverProviderResult | null> {
    let lastProviderError: unknown = null;
    for (const provider of this.providers) {
      try {
        const meting = new Meting(provider);
        meting.format(true);
        const candidates = await this.searchProvider(meting, provider, song);
        const match = selectBestCoverCandidate(song, candidates);
        if (!match) {
          continue;
        }

        const imageUrl = await this.fetchImageUrl(meting, match.picId);
        if (!imageUrl) {
          continue;
        }

        return {
          provider,
          providerSongId: match.providerSongId,
          title: match.title,
          artistNames: match.artistNames,
          albumName: match.albumName,
          imageUrl,
          confidence: match.confidence,
          payload: match.payload ?? {}
        };
      } catch (error) {
        lastProviderError = error;
        continue;
      }
    }

    if (lastProviderError) {
      throw lastProviderError;
    }
    return null;
  }

  private async searchProvider(
    meting: Meting,
    provider: MetingProviderId,
    song: SongCoverBackfillCandidate
  ): Promise<CoverCandidate[]> {
    const keyword = `${song.artistName} ${song.title}`.trim();
    const raw = await withTimeout(
      meting.search(keyword, { page: 1, limit: this.searchLimit }),
      this.requestTimeoutMs,
      `${provider} search timeout`
    );
    const payload = parseJson(raw);
    if (!Array.isArray(payload)) {
      return [];
    }

    return payload
      .map((item): CoverCandidate | null => {
        if (!isRecord(item)) {
          return null;
        }
        const metingSong = item as MetingSongPayload;
        const title = typeof metingSong.name === "string" ? metingSong.name : "";
        const picId = metingSong.pic_id == null ? "" : String(metingSong.pic_id);
        const providerSongId = metingSong.id == null ? "" : String(metingSong.id);
        if (!title || !providerSongId || !picId) {
          return null;
        }
        return {
          provider,
          providerSongId,
          title,
          artistNames: normalizeArtistPayload(metingSong.artist),
          albumName: typeof metingSong.album === "string" ? metingSong.album : "",
          picId,
          payload: item
        };
      })
      .filter((candidate): candidate is CoverCandidate => candidate !== null);
  }

  private async fetchImageUrl(meting: Meting, picId: string): Promise<string | null> {
    const raw = await withTimeout(meting.pic(picId, this.imageSize), this.requestTimeoutMs, "cover image timeout");
    const payload = parseJson(raw);
    if (isRecord(payload) && typeof payload.url === "string" && payload.url.startsWith("http")) {
      return payload.url;
    }
    if (typeof payload === "string" && payload.startsWith("http")) {
      return payload;
    }
    return null;
  }
}

function normalizeArtistPayload(value: MetingSongPayload["artist"]): string[] {
  if (Array.isArray(value)) {
    return value.filter((artist): artist is string => typeof artist === "string" && artist.trim().length > 0);
  }
  return typeof value === "string" && value.trim().length > 0 ? [value] : [];
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
