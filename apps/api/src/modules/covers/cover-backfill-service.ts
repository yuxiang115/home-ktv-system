import type { SongCoverCacheRepository } from "./song-cover-cache-repository.js";
import type { SongCoverProvider, SongCoverSource } from "./types.js";

export interface BackfillSongCoversInput {
  cache: SongCoverCacheRepository;
  provider: SongCoverProvider;
  limit: number;
  source?: SongCoverSource;
  retryFailed?: boolean;
  delayMs?: number;
  logger?: Pick<Console, "error" | "log">;
}

export interface BackfillSongCoversResult {
  total: number;
  found: number;
  notFound: number;
  failed: number;
}

export async function backfillSongCovers(input: BackfillSongCoversInput): Promise<BackfillSongCoversResult> {
  const logger = input.logger ?? console;
  const candidates = await input.cache.listCoverCandidates({
    limit: input.limit,
    ...(input.source ? { source: input.source } : {}),
    ...(input.retryFailed === undefined ? {} : { retryFailed: input.retryFailed })
  });
  const result: BackfillSongCoversResult = {
    total: candidates.length,
    found: 0,
    notFound: 0,
    failed: 0
  };

  for (const [index, candidate] of candidates.entries()) {
    try {
      const cover = await input.provider.findCover(candidate);
      if (!cover) {
        await input.cache.upsertCoverResult({
          ...candidate,
          status: "not_found",
          confidence: 0,
          errorMessage: "No reliable cover match found"
        });
        result.notFound += 1;
        logger.log(`[covers] ${index + 1}/${candidates.length} not_found ${candidate.artistName} - ${candidate.title}`);
      } else {
        await input.cache.upsertCoverResult({
          ...candidate,
          status: "found",
          imageUrl: cover.imageUrl,
          provider: cover.provider,
          providerSongId: cover.providerSongId,
          providerPayload: cover.payload,
          confidence: cover.confidence
        });
        result.found += 1;
        logger.log(
          `[covers] ${index + 1}/${candidates.length} found ${candidate.artistName} - ${candidate.title} via ${cover.provider}`
        );
      }
    } catch (error) {
      await input.cache.upsertCoverResult({
        ...candidate,
        status: "failed",
        confidence: 0,
        errorMessage: error instanceof Error ? error.message : String(error)
      });
      result.failed += 1;
      logger.error(
        `[covers] ${index + 1}/${candidates.length} failed ${candidate.artistName} - ${candidate.title}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    if (input.delayMs && index < candidates.length - 1) {
      await delay(input.delayMs);
    }
  }

  return result;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
