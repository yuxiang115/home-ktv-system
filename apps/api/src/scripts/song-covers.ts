import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { backfillSongCovers } from "../modules/covers/cover-backfill-service.js";
import { MetingCoverProvider, type MetingProviderId } from "../modules/covers/meting-cover-provider.js";
import { PgSongCoverCacheRepository } from "../modules/covers/song-cover-cache-repository.js";
import type { SongCoverSource } from "../modules/covers/types.js";

interface CliOptions {
  limit: number;
  source?: SongCoverSource;
  retryFailed: boolean;
  delayMs: number;
  providers: MetingProviderId[];
}

const defaultOptions: CliOptions = {
  limit: 300,
  retryFailed: false,
  delayMs: 600,
  providers: ["tencent", "kugou", "netease", "kuwo"]
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const cache = new PgSongCoverCacheRepository(pool);
    const provider = new MetingCoverProvider({
      providers: options.providers,
      imageSize: 300,
      searchLimit: 8
    });
    const result = await backfillSongCovers({
      cache,
      provider,
      limit: options.limit,
      ...(options.source ? { source: options.source } : {}),
      retryFailed: options.retryFailed,
      delayMs: options.delayMs
    });
    console.log(
      `[covers] done total=${result.total} found=${result.found} not_found=${result.notFound} failed=${result.failed}`
    );
  } finally {
    await pool.end();
  }
}

function parseArgs(args: readonly string[]): CliOptions {
  const options: CliOptions = { ...defaultOptions, providers: [...defaultOptions.providers] };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const next = args[index + 1];
    if (arg === "--limit" && next) {
      options.limit = readPositiveInteger(next, options.limit);
      index += 1;
      continue;
    }
    if (arg === "--source" && next) {
      if (next !== "formal" && next !== "ktv-index") {
        throw new Error("--source must be formal or ktv-index");
      }
      options.source = next;
      index += 1;
      continue;
    }
    if (arg === "--retry-failed") {
      options.retryFailed = true;
      continue;
    }
    if (arg === "--delay-ms" && next) {
      options.delayMs = readPositiveInteger(next, options.delayMs);
      index += 1;
      continue;
    }
    if (arg === "--providers" && next) {
      options.providers = next.split(",").map(readProvider);
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function readPositiveInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readProvider(value: string): MetingProviderId {
  const provider = value.trim();
  if (provider === "tencent" || provider === "kugou" || provider === "netease" || provider === "kuwo" || provider === "baidu") {
    return provider;
  }
  throw new Error(`Unsupported provider: ${value}`);
}

function printHelp() {
  console.log(`Usage: pnpm -F @home-ktv/api covers:songs -- [options]

Options:
  --limit <n>             Max songs to process, default 300
  --source <kind>         formal or ktv-index, default both
  --retry-failed          Retry rows currently marked failed
  --delay-ms <n>          Delay between provider requests, default 600
  --providers <list>      Comma list, default tencent,kugou,netease,kuwo
`);
}

const entrypointUrl = pathToFileURL(process.argv[1] ?? "").href;

if (import.meta.url === entrypointUrl) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
