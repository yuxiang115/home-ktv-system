import path from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import type { QueryExecutor } from "../db/query-executor.js";
import {
  HttpNeteaseStyleTaggerClient,
  NeteaseStyleTagger
} from "../modules/ktv-index/netease-style-tagger.js";
import { KtvStyleTaggingService } from "../modules/ktv-index/ktv-style-tagging-service.js";

const DEFAULT_SOURCE = "netease-playlist-v1";

export interface KtvStyleTagsCliOptions {
  apply: boolean;
  baseUrl: string;
  databaseUrl: string | undefined;
  help: boolean;
  limit: number;
  onlyMissing: boolean;
  source: "netease";
  taggingSource: string;
}

interface DbClient extends QueryExecutor {
  connect?(): Promise<unknown>;
  end(): Promise<void>;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  runKtvStyleTagsCli(process.argv.slice(2)).then((exitCode) => {
    process.exit(exitCode);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export async function runKtvStyleTagsCli(
  argv: readonly string[],
  dependencies: {
    createDbClient?: (databaseUrl: string) => DbClient;
    env?: Record<string, string | undefined>;
    stdout?: (line: string) => void;
  } = {}
): Promise<number> {
  const options = parseKtvStyleTagsCliOptions(argv, dependencies.env ?? process.env);
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
    const client = new HttpNeteaseStyleTaggerClient({ baseUrl: options.baseUrl });
    const service = new KtvStyleTaggingService(db, {
      tagger: new NeteaseStyleTagger({ client })
    });
    const result = await service.run({
      source: options.taggingSource,
      limit: options.limit,
      apply: options.apply,
      onlyMissing: options.onlyMissing
    });
    stdout("KTV style tagging summary");
    stdout(`mode=${options.apply ? "apply" : "dry-run"} source=${options.taggingSource}`);
    stdout(
      `selected=${result.selected} processed=${result.processed} tagged=${result.taggedSongs} empty=${result.emptySongs} failed=${result.failedSongs}`
    );
    stdout(`writtenTags=${result.writtenTags} averageTags=${result.averageTags} elapsedMs=${result.elapsedMs}`);
    return 0;
  } finally {
    await db.end();
  }
}

export function parseKtvStyleTagsCliOptions(
  args: readonly string[],
  env: Record<string, string | undefined> = process.env
): KtvStyleTagsCliOptions {
  const options: KtvStyleTagsCliOptions = {
    apply: false,
    baseUrl: clean(env.NETEASE_API_BASE_URL) ?? "http://127.0.0.1:3301",
    databaseUrl: clean(env.DATABASE_URL),
    help: false,
    limit: 300,
    onlyMissing: true,
    source: "netease",
    taggingSource: DEFAULT_SOURCE
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
      case "--apply":
        options.apply = true;
        break;
      case "--dry-run":
        options.apply = false;
        break;
      case "--all":
        options.onlyMissing = false;
        break;
      case "--only-missing":
        options.onlyMissing = true;
        break;
      case "--base-url":
        options.baseUrl = requireValue(args, index, arg);
        index += 1;
        break;
      case "--database-url":
        options.databaseUrl = requireValue(args, index, arg);
        index += 1;
        break;
      case "--limit":
        options.limit = parsePositiveInteger(requireValue(args, index, arg), arg);
        index += 1;
        break;
      case "--source": {
        const source = requireValue(args, index, arg);
        if (source !== "netease") {
          throw new Error("--source currently supports only netease");
        }
        options.source = source;
        options.taggingSource = DEFAULT_SOURCE;
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function createPgClient(databaseUrl: string): DbClient {
  return new Pool({ connectionString: databaseUrl });
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
  pnpm -F @home-ktv/api tag:ktv-styles -- --limit 300 --dry-run
  pnpm -F @home-ktv/api tag:ktv-styles -- --limit 300 --apply

Options:
  --limit <count>       Number of songs to process. Default: 300.
  --apply               Write tags and status rows. Default is dry-run.
  --dry-run             Call tagger and print summary without writing tags.
  --only-missing        Process songs missing this source. Default.
  --all                 Process all active indexed songs.
  --source netease      Use Netease playlist semantics.
  --base-url <url>      NeteaseCloudMusicApi URL. Default: NETEASE_API_BASE_URL or http://127.0.0.1:3301.
  --database-url <url>  PostgreSQL URL. Defaults to DATABASE_URL.
`;
}
