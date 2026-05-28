import path from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import type { QueryExecutor } from "../db/query-executor.js";
import {
  CachedNeteaseStyleTaggerClient,
  HttpNeteaseStyleTaggerClient,
  NeteaseStyleTagger
} from "../modules/ktv-index/netease-style-tagger.js";
import { HttpLlmStyleTaggerClient, LlmStyleTagger } from "../modules/ktv-index/llm-style-tagger.js";
import {
  KtvStyleTaggingService,
  type KtvStyleTaggingProgressEvent
} from "../modules/ktv-index/ktv-style-tagging-service.js";

const NETEASE_SOURCE = "netease-playlist-v1";
const LLM_SOURCE = "llm-style-v1";

export interface KtvStyleTagsCliOptions {
  apply: boolean;
  baseUrl: string;
  databaseUrl: string | undefined;
  help: boolean;
  limit: number;
  llmApiKey: string | undefined;
  llmBaseUrl: string | undefined;
  llmModel: string | undefined;
  maxExistingTags: number | undefined;
  onlyMissing: boolean;
  progressEvery: number;
  source: "netease" | "llm";
  taggingSource: string;
}

interface DbClient extends QueryExecutor {
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
  try {
    const service = new KtvStyleTaggingService(db, {
      tagger: createTagger(options, db)
    });
    const runInput = {
      source: options.taggingSource,
      limit: options.limit,
      apply: options.apply,
      onlyMissing: options.onlyMissing,
      onProgress: (event: KtvStyleTaggingProgressEvent) => {
        if (event.processed === event.selected || event.processed % options.progressEvery === 0) {
          stdout(
            `progress=${event.processed}/${event.selected} status=${event.status} tags=${event.tagCount} elapsedMs=${event.elapsedMs} song=${event.artistName} - ${event.title}`
          );
        }
      }
    };
    const result = await service.run(
      options.maxExistingTags === undefined ? runInput : { ...runInput, maxExistingTags: options.maxExistingTags }
    );
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
    llmApiKey: clean(env.LLM_API_KEY) ?? clean(env.KTV_LLM_API_KEY),
    llmBaseUrl: clean(env.LLM_API_BASE_URL) ?? clean(env.KTV_LLM_BASE_URL),
    llmModel: clean(env.LLM_MODEL) ?? clean(env.KTV_LLM_MODEL),
    maxExistingTags: undefined,
    onlyMissing: true,
    progressEvery: 10,
    source: "netease",
    taggingSource: NETEASE_SOURCE
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
      case "--llm-base-url":
        options.llmBaseUrl = requireValue(args, index, arg);
        index += 1;
        break;
      case "--llm-api-key":
        options.llmApiKey = requireValue(args, index, arg);
        index += 1;
        break;
      case "--llm-model":
        options.llmModel = requireValue(args, index, arg);
        index += 1;
        break;
      case "--max-existing-tags":
        options.maxExistingTags = parseNonNegativeInteger(requireValue(args, index, arg), arg);
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
      case "--progress-every":
        options.progressEvery = parsePositiveInteger(requireValue(args, index, arg), arg);
        index += 1;
        break;
      case "--source": {
        const source = requireValue(args, index, arg);
        if (source !== "netease" && source !== "llm") {
          throw new Error("--source supports netease or llm");
        }
        options.source = source;
        options.taggingSource = source === "netease" ? NETEASE_SOURCE : LLM_SOURCE;
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.source === "llm" && options.maxExistingTags === undefined) {
    options.maxExistingTags = 1;
  }

  return options;
}

function createTagger(options: KtvStyleTagsCliOptions, db: QueryExecutor) {
  if (options.source === "netease") {
    const client = new CachedNeteaseStyleTaggerClient(
      db,
      new HttpNeteaseStyleTaggerClient({ baseUrl: options.baseUrl }),
      options.taggingSource
    );
    return new NeteaseStyleTagger({ client });
  }

  if (!options.llmBaseUrl) {
    throw new Error("LLM_API_BASE_URL, KTV_LLM_BASE_URL, or --llm-base-url is required for --source llm");
  }
  if (!options.llmApiKey) {
    throw new Error("LLM_API_KEY, KTV_LLM_API_KEY, or --llm-api-key is required for --source llm");
  }
  if (!options.llmModel) {
    throw new Error("LLM_MODEL, KTV_LLM_MODEL, or --llm-model is required for --source llm");
  }

  return new LlmStyleTagger({
    client: new HttpLlmStyleTaggerClient({
      apiKey: options.llmApiKey,
      baseUrl: options.llmBaseUrl,
      model: options.llmModel
    }),
    model: options.llmModel
  });
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

function parseNonNegativeInteger(raw: string, optionName: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${optionName} must be a non-negative integer`);
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
  --progress-every <n>  Print one progress line every n songs. Default: 10.
  --source netease      Use Netease playlist semantics.
  --base-url <url>      NeteaseCloudMusicApi URL. Default: NETEASE_API_BASE_URL or http://127.0.0.1:3301.
  --source llm          Use LLM fallback semantics. Defaults to --max-existing-tags 1.
  --llm-base-url <url>  OpenAI-compatible base URL. Defaults to LLM_API_BASE_URL or KTV_LLM_BASE_URL.
  --llm-api-key <key>   OpenAI-compatible API key. Defaults to LLM_API_KEY or KTV_LLM_API_KEY.
  --llm-model <model>   Chat model name. Defaults to LLM_MODEL or KTV_LLM_MODEL.
  --max-existing-tags <n>
                        With --source llm, process songs whose aggregate tag count is <= n. Default: 1.
  --database-url <url>  PostgreSQL URL. Defaults to DATABASE_URL.
`;
}
