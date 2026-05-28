import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { MetingCoverProvider, type MetingCoverProviderOptions, type MetingProviderId } from "../modules/covers/meting-cover-provider.js";
import type { SongCoverBackfillCandidate, SongCoverProvider } from "../modules/covers/types.js";

export type SongCoverCoverageSource = "formal" | "ktv-index";

export interface SongCoverCoverageCliOptions {
  databaseUrl: string;
  delayMs: number;
  help: boolean;
  limit: number;
  progressEvery: number;
  providers: MetingProviderId[];
  requestTimeoutMs: number;
  searchLimit: number;
  source: SongCoverCoverageSource;
}

export interface SongCoverCoverageCliDependencies {
  closeTimeoutMs?: number;
  createDbClient?: (databaseUrl: string) => SongCoverCoverageDbClient;
  createProvider?: (options: MetingCoverProviderOptions) => SongCoverProvider;
  env?: Record<string, string | undefined>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  stdout?: (line: string) => void;
}

export interface SongCoverCoverageDbClient {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}

interface SampleSongRow {
  sourceSongId: string;
  title: string;
  artistName: string;
}

interface CoverageStats {
  total: number;
  found: number;
  notFound: number;
  failed: number;
  providerHits: Map<string, number>;
  confidenceSum: number;
  durations: number[];
  foundSamples: Array<{ title: string; artistName: string; provider: string; confidence: number; imageUrl: string }>;
  notFoundSamples: Array<{ title: string; artistName: string }>;
  failedSamples: Array<{ title: string; artistName: string; error: string }>;
}

const defaultProviders: MetingProviderId[] = ["tencent", "kugou", "netease", "kuwo"];
const defaultSource: SongCoverCoverageSource = "ktv-index";

const defaultOptions = {
  delayMs: 250,
  limit: 100,
  progressEvery: 20,
  providers: defaultProviders,
  requestTimeoutMs: 6000,
  searchLimit: 8,
  source: defaultSource
};

export function parseSongCoverCoverageCliOptions(
  args: readonly string[],
  env: Record<string, string | undefined> = process.env
): SongCoverCoverageCliOptions {
  const options: SongCoverCoverageCliOptions = {
    databaseUrl: clean(env.DATABASE_URL),
    delayMs: defaultOptions.delayMs,
    help: false,
    limit: defaultOptions.limit,
    progressEvery: defaultOptions.progressEvery,
    providers: [...defaultOptions.providers],
    requestTimeoutMs: defaultOptions.requestTimeoutMs,
    searchLimit: defaultOptions.searchLimit,
    source: defaultOptions.source
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const next = args[index + 1];
    if (arg === "--") {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--database-url" && next) {
      options.databaseUrl = clean(next);
      index += 1;
      continue;
    }
    if (arg === "--limit" && next) {
      options.limit = readPositiveInteger(next, options.limit);
      index += 1;
      continue;
    }
    if (arg === "--delay-ms" && next) {
      options.delayMs = readNonNegativeInteger(next, options.delayMs);
      index += 1;
      continue;
    }
    if (arg === "--progress-every" && next) {
      options.progressEvery = readPositiveInteger(next, options.progressEvery);
      index += 1;
      continue;
    }
    if (arg === "--search-limit" && next) {
      options.searchLimit = readPositiveInteger(next, options.searchLimit);
      index += 1;
      continue;
    }
    if (arg === "--request-timeout-ms" && next) {
      options.requestTimeoutMs = readPositiveInteger(next, options.requestTimeoutMs);
      index += 1;
      continue;
    }
    if (arg === "--source" && next) {
      options.source = readSource(next);
      index += 1;
      continue;
    }
    if (arg === "--providers" && next) {
      options.providers = next.split(",").map(readProvider);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

export async function runSongCoverCoverageCli(
  args: readonly string[],
  dependencies: SongCoverCoverageCliDependencies = {}
): Promise<number> {
  const output = dependencies.stdout ?? console.log;
  const now = dependencies.now ?? Date.now;
  const options = parseSongCoverCoverageCliOptions(args, dependencies.env ?? process.env);
  if (options.help) {
    output(helpText());
    return 0;
  }
  if (!options.databaseUrl) {
    throw new Error("DATABASE_URL or --database-url is required");
  }

  const db = dependencies.createDbClient?.(options.databaseUrl) ?? new Pool({ connectionString: options.databaseUrl });
  const provider = dependencies.createProvider?.({
    providers: options.providers,
    imageSize: 300,
    requestTimeoutMs: options.requestTimeoutMs,
    searchLimit: options.searchLimit
  }) ?? new MetingCoverProvider({
    providers: options.providers,
    imageSize: 300,
    requestTimeoutMs: options.requestTimeoutMs,
    searchLimit: options.searchLimit
  });

  try {
    const songs = await listSampleSongs(db, options);
    const stats = createEmptyStats(songs.length);
    const startedAt = now();
    output(`[coverage] sample=${songs.length} source=${options.source} providers=${options.providers.join(",")} delayMs=${options.delayMs}`);

    for (const [index, song] of songs.entries()) {
      const candidate = toBackfillCandidate(options.source, song);
      const requestStartedAt = now();
      try {
        const cover = await provider.findCover(candidate);
        stats.durations.push(now() - requestStartedAt);
        if (!cover) {
          stats.notFound += 1;
          pushSample(stats.notFoundSamples, { title: candidate.title, artistName: candidate.artistName }, 12);
        } else {
          stats.found += 1;
          stats.confidenceSum += cover.confidence;
          stats.providerHits.set(cover.provider, (stats.providerHits.get(cover.provider) ?? 0) + 1);
          pushSample(
            stats.foundSamples,
            {
              title: candidate.title,
              artistName: candidate.artistName,
              provider: cover.provider,
              confidence: cover.confidence,
              imageUrl: cover.imageUrl
            },
            8
          );
        }
      } catch (error) {
        stats.durations.push(now() - requestStartedAt);
        stats.failed += 1;
        pushSample(
          stats.failedSamples,
          {
            title: candidate.title,
            artistName: candidate.artistName,
            error: error instanceof Error ? error.message : String(error)
          },
          12
        );
      }

      if ((index + 1) % options.progressEvery === 0 || index + 1 === songs.length) {
        output(progressLine(index + 1, stats));
      }
      if (options.delayMs > 0 && index + 1 < songs.length) {
        await (dependencies.sleep ?? sleep)(options.delayMs);
      }
    }

    output(`[coverage] summary=${JSON.stringify(summary(stats, now() - startedAt), null, 2)}`);
    return 0;
  } finally {
    await closeDb(db, dependencies.closeTimeoutMs ?? 5000);
  }
}

async function listSampleSongs(
  db: SongCoverCoverageDbClient,
  options: Pick<SongCoverCoverageCliOptions, "limit" | "source">
): Promise<SampleSongRow[]> {
  if (options.source === "formal") {
    const result = await db.query<SampleSongRow>(
      `SELECT s.id AS "sourceSongId",
              s.title,
              s.artist_name AS "artistName"
       FROM songs s
       WHERE s.status = 'ready'
         AND trim(s.title) <> ''
         AND trim(s.artist_name) <> ''
         AND EXISTS (
           SELECT 1
           FROM assets a
           WHERE a.song_id = s.id
             AND a.status = 'ready'
         )
       ORDER BY random()
       LIMIT $1`,
      [options.limit]
    );
    return result.rows;
  }

  const result = await db.query<SampleSongRow>(
    `SELECT s.id AS "sourceSongId",
            s.title,
            s.primary_artist_name AS "artistName"
     FROM ktv_songs s
     WHERE trim(s.title) <> ''
       AND trim(s.primary_artist_name) <> ''
       AND EXISTS (
         SELECT 1
         FROM ktv_song_assets a
         WHERE a.song_id = s.id
           AND a.missing_at IS NULL
       )
     ORDER BY random()
     LIMIT $1`,
    [options.limit]
  );
  return result.rows;
}

function toBackfillCandidate(source: SongCoverCoverageSource, row: SampleSongRow): SongCoverBackfillCandidate {
  return {
    source,
    sourceSongId: row.sourceSongId,
    title: row.title,
    artistName: row.artistName
  };
}

function createEmptyStats(total: number): CoverageStats {
  return {
    total,
    found: 0,
    notFound: 0,
    failed: 0,
    providerHits: new Map(),
    confidenceSum: 0,
    durations: [],
    foundSamples: [],
    notFoundSamples: [],
    failedSamples: []
  };
}

function progressLine(done: number, stats: Pick<CoverageStats, "total" | "found" | "notFound" | "failed">): string {
  return `[coverage] progress=${done}/${stats.total} found=${stats.found} not_found=${stats.notFound} failed=${stats.failed} hitRate=${percent(stats.found, done)}`;
}

function summary(stats: CoverageStats, elapsedMs: number) {
  const durations = [...stats.durations].sort((left, right) => left - right);
  const avgMs = stats.durations.reduce((total, duration) => total + duration, 0) / Math.max(1, stats.durations.length);
  const p95Ms = durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)] ?? 0;
  return {
    sample: stats.total,
    found: stats.found,
    notFound: stats.notFound,
    failed: stats.failed,
    hitRate: percent(stats.found, stats.total),
    effectiveHitRateExcludingFailed: percent(stats.found, stats.total - stats.failed),
    avgConfidence: stats.found === 0 ? 0 : Number((stats.confidenceSum / stats.found).toFixed(1)),
    avgMs: Number(avgMs.toFixed(0)),
    p95Ms,
    elapsedSec: Number((elapsedMs / 1000).toFixed(1)),
    providerHits: Object.fromEntries(stats.providerHits),
    foundSamples: stats.foundSamples,
    notFoundSamples: stats.notFoundSamples,
    failedSamples: stats.failedSamples
  };
}

function pushSample<T>(samples: T[], sample: T, limit: number): void {
  if (samples.length < limit) {
    samples.push(sample);
  }
}

function percent(numerator: number, denominator: number): string {
  return denominator <= 0 ? "0.0%" : `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function readSource(value: string): SongCoverCoverageSource {
  if (value === "formal" || value === "ktv-index") {
    return value;
  }
  throw new Error("--source must be formal or ktv-index");
}

function readProvider(value: string): MetingProviderId {
  const provider = value.trim();
  if (provider === "tencent" || provider === "kugou" || provider === "netease" || provider === "kuwo" || provider === "baidu") {
    return provider;
  }
  throw new Error(`Unsupported provider: ${value}`);
}

function readPositiveInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function closeDb(db: SongCoverCoverageDbClient, timeoutMs: number): Promise<void> {
  await Promise.race([db.end(), sleep(timeoutMs).then(() => undefined)]);
}

function helpText(): string {
  return `Usage: pnpm -F @home-ktv/api covers:coverage -- [options]

Options:
  --limit <n>                 Random sample size, default 100
  --source <kind>             formal or ktv-index, default ktv-index
  --delay-ms <n>              Delay between lookups, default 250
  --providers <list>          Comma list, default tencent,kugou,netease,kuwo
  --progress-every <n>        Progress log cadence, default 20
  --search-limit <n>          Provider search result limit, default 8
  --request-timeout-ms <n>    Provider request timeout, default 6000
  --database-url <url>        PostgreSQL URL. Defaults to DATABASE_URL.
`;
}

const entrypointUrl = pathToFileURL(process.argv[1] ?? "").href;

if (import.meta.url === entrypointUrl) {
  runSongCoverCoverageCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
