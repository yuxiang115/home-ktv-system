import path from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import type { QueryExecutor } from "../db/query-executor.js";
import { parseMediaPathMappings, type MediaPathMapping } from "../modules/assets/media-path-mapping.js";
import {
  KtvIndexTechnicalProbeService,
  type KtvIndexTechnicalProbeResult,
  type ProbeKtvIndexAssetsInput
} from "../modules/ktv-index/ktv-index-technical-probe.js";

const DEFAULT_CLOSE_TIMEOUT_MS = 5000;

export interface KtvIndexProbeCliOptions {
  assetId: string | undefined;
  concurrency: number;
  databaseUrl: string | undefined;
  dryRun: boolean;
  help: boolean;
  limit: number | undefined;
  mediaPathMappings: string | undefined;
  retryFailed: boolean;
}

interface DbClient extends QueryExecutor {
  connect?(): Promise<unknown>;
  end(): Promise<void>;
}

interface ProbeService {
  probeKtvIndexAssets(input: ProbeKtvIndexAssetsInput): Promise<KtvIndexTechnicalProbeResult>;
}

export interface RunKtvIndexProbeCliDependencies {
  closeTimeoutMs?: number;
  createDbClient?: (databaseUrl: string) => DbClient;
  createService?: (db: QueryExecutor, options: { pathMappings: MediaPathMapping[] }) => ProbeService;
  env?: Record<string, string | undefined>;
  stdout?: (line: string) => void;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  runKtvIndexProbeCli(process.argv.slice(2)).then((exitCode) => {
    process.exit(exitCode);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export async function runKtvIndexProbeCli(
  argv: readonly string[],
  dependencies: RunKtvIndexProbeCliDependencies = {}
): Promise<number> {
  const env = dependencies.env ?? process.env;
  const options = parseKtvIndexProbeCliOptions(argv, env);
  const stdout = dependencies.stdout ?? console.log;

  if (options.help) {
    stdout(usage());
    return 0;
  }

  if (!options.databaseUrl) {
    throw new Error("DATABASE_URL or --database-url is required");
  }

  const db = (dependencies.createDbClient ?? createPgClient)(options.databaseUrl);
  await db.connect?.();
  try {
    const service = (dependencies.createService ?? createProbeService)(db, {
      pathMappings: parseMediaPathMappings(options.mediaPathMappings)
    });
    const result = await service.probeKtvIndexAssets({
      limit: options.limit,
      concurrency: options.concurrency,
      retryFailed: options.retryFailed,
      dryRun: options.dryRun,
      assetId: options.assetId
    });
    printSummary(result, stdout);
    return 0;
  } finally {
    await closeDbClient(db, dependencies.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS);
  }
}

export function parseKtvIndexProbeCliOptions(
  args: readonly string[],
  env: Record<string, string | undefined> = process.env
): KtvIndexProbeCliOptions {
  const options: KtvIndexProbeCliOptions = {
    assetId: undefined,
    concurrency: 2,
    databaseUrl: clean(env.DATABASE_URL),
    dryRun: false,
    help: false,
    limit: undefined,
    mediaPathMappings: clean(env.MEDIA_PATH_MAPPINGS),
    retryFailed: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--":
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--limit":
        options.limit = parsePositiveInteger(requireValue(args, index, arg), arg);
        index += 1;
        break;
      case "--concurrency":
        options.concurrency = parsePositiveInteger(requireValue(args, index, arg), arg);
        index += 1;
        break;
      case "--retry-failed":
        options.retryFailed = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--asset-id":
        options.assetId = requireValue(args, index, arg);
        index += 1;
        break;
      case "--database-url":
        options.databaseUrl = requireValue(args, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function createPgClient(databaseUrl: string): DbClient {
  return new Pool({ connectionString: databaseUrl });
}

function createProbeService(db: QueryExecutor, options: { pathMappings: MediaPathMapping[] }): ProbeService {
  return new KtvIndexTechnicalProbeService(db, {
    pathMappings: options.pathMappings
  });
}

function printSummary(result: KtvIndexTechnicalProbeResult, stdout: (line: string) => void): void {
  stdout("KTV index probe summary");
  stdout(`selected=${result.selected} probed=${result.probed} failed=${result.failed} skipped=${result.skipped}`);
  stdout(`tracks:1=${result.singleTrack} tracks:2=${result.dualTrack} tracks:3+=${result.multiTrack} elapsedMs=${result.elapsedMs}`);
}

async function closeDbClient(db: DbClient, timeoutMs: number): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db.end(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, Math.max(1, timeoutMs));
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function requireValue(args: readonly string[], index: number, optionName: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

function parsePositiveInteger(raw: string, optionName: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${optionName} must be a positive integer`);
  }
  return value;
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed || undefined;
}

function usage(): string {
  return `Usage:
  pnpm -F @home-ktv/api probe:ktv-index -- --limit 300 --concurrency 2

Options:
  --limit <count>          Optional number of active assets to probe.
  --concurrency <count>    Concurrent probes. Default: 2.
  --retry-failed           Include previously failed assets.
  --dry-run                Select targets without probing or writing.
  --asset-id <id>          Probe one indexed asset.
  --database-url <url>     PostgreSQL URL. Defaults to DATABASE_URL.
`;
}
