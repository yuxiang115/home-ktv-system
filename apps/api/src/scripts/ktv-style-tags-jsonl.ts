import path from "node:path";
import { pathToFileURL } from "node:url";
import { HttpLlmStyleTaggerClient, LlmStyleTagger } from "../modules/ktv-index/llm-style-tagger.js";
import {
  HttpNeteaseStyleTaggerClient,
  NeteaseStyleTagger
} from "../modules/ktv-index/netease-style-tagger.js";
import {
  LLM_STYLE_TAGGING_SOURCE,
  NETEASE_STYLE_TAGGING_SOURCE,
  runStyleTaggingJsonl,
  type StyleTaggingJsonlProgressEvent,
  type StyleTaggingJsonlTagger
} from "../modules/ktv-index/style-tagging-jsonl.js";

export interface KtvStyleTagsJsonlCliOptions {
  baseUrl: string;
  help: boolean;
  inputPath: string;
  limit: number | undefined;
  llmApiKey: string | undefined;
  llmBaseUrl: string | undefined;
  llmModel: string | undefined;
  outputPath: string;
  progressEvery: number;
  source: "netease" | "llm";
  taggingSource: string;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  runKtvStyleTagsJsonlCli(process.argv.slice(2)).then((exitCode) => {
    process.exit(exitCode);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export async function runKtvStyleTagsJsonlCli(
  argv: readonly string[],
  dependencies: {
    env?: Record<string, string | undefined>;
    stdout?: (line: string) => void;
    createTagger?: (options: KtvStyleTagsJsonlCliOptions) => StyleTaggingJsonlTagger;
  } = {}
): Promise<number> {
  const options = parseKtvStyleTagsJsonlCliOptions(argv, dependencies.env ?? process.env);
  const stdout = dependencies.stdout ?? console.log;
  if (options.help) {
    stdout(usage());
    return 0;
  }

  const result = await runStyleTaggingJsonl({
    inputPath: options.inputPath,
    outputPath: options.outputPath,
    source: options.taggingSource,
    tagger: (dependencies.createTagger ?? createTagger)(options),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    onProgress: (event: StyleTaggingJsonlProgressEvent) => {
      if (event.processed === event.selected - event.skipped || event.processed % options.progressEvery === 0) {
        stdout(
          `progress=${event.processed}/${event.selected} skipped=${event.skipped} status=${event.status} tags=${event.tagCount} elapsedMs=${event.elapsedMs} song=${event.artistName} - ${event.title}`
        );
      }
    }
  });
  stdout("KTV style tagging JSONL summary");
  stdout(`source=${options.taggingSource} input=${options.inputPath} output=${options.outputPath}`);
  stdout(
    `selected=${result.selected} processed=${result.processed} skipped=${result.skipped} tagged=${result.tagged} empty=${result.empty} failed=${result.failed}`
  );
  stdout(`elapsedMs=${result.elapsedMs}`);
  return 0;
}

export function parseKtvStyleTagsJsonlCliOptions(
  args: readonly string[],
  env: Record<string, string | undefined> = process.env
): KtvStyleTagsJsonlCliOptions {
  const options: KtvStyleTagsJsonlCliOptions = {
    baseUrl: clean(env.NETEASE_API_BASE_URL) ?? "http://127.0.0.1:3301",
    help: false,
    inputPath: "",
    limit: undefined,
    llmApiKey: clean(env.LLM_API_KEY) ?? clean(env.KTV_LLM_API_KEY),
    llmBaseUrl: clean(env.LLM_API_BASE_URL) ?? clean(env.KTV_LLM_BASE_URL),
    llmModel: clean(env.LLM_MODEL) ?? clean(env.KTV_LLM_MODEL),
    outputPath: "",
    progressEvery: 10,
    source: "netease",
    taggingSource: NETEASE_STYLE_TAGGING_SOURCE
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
      case "--input":
        options.inputPath = requireValue(args, index, arg);
        index += 1;
        break;
      case "--output":
      case "--out":
        options.outputPath = requireValue(args, index, arg);
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
      case "--source": {
        const source = requireValue(args, index, arg);
        if (source !== "netease" && source !== "llm") {
          throw new Error("--source supports netease or llm");
        }
        options.source = source;
        options.taggingSource = source === "netease" ? NETEASE_STYLE_TAGGING_SOURCE : LLM_STYLE_TAGGING_SOURCE;
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.help && options.inputPath.length === 0) {
    throw new Error("--input is required");
  }
  if (!options.help && options.outputPath.length === 0) {
    throw new Error("--output is required");
  }

  return options;
}

function createTagger(options: KtvStyleTagsJsonlCliOptions): StyleTaggingJsonlTagger {
  if (options.source === "netease") {
    return new NeteaseStyleTagger({
      client: new HttpNeteaseStyleTaggerClient({ baseUrl: options.baseUrl })
    }) as StyleTaggingJsonlTagger;
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
  }) as StyleTaggingJsonlTagger;
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
  pnpm -F @home-ktv/api tag:ktv-styles:jsonl -- --input runtime/media/tagging/full/songs.jsonl --output runtime/media/tagging/full/results.jsonl

Options:
  --input <path>        Input song snapshot JSONL path.
  --output <path>       Output result JSONL path. Existing rows are used for resume.
  --limit <count>       Optional number of input rows to consider.
  --progress-every <n>  Print one progress line every n processed songs. Default: 10.
  --source netease      Use Netease playlist semantics. Default.
  --base-url <url>      NeteaseCloudMusicApi URL. Default: NETEASE_API_BASE_URL or http://127.0.0.1:3301.
  --source llm          Use LLM fallback semantics.
  --llm-base-url <url>  OpenAI-compatible base URL. Defaults to LLM_API_BASE_URL or KTV_LLM_BASE_URL.
  --llm-api-key <key>   OpenAI-compatible API key. Defaults to LLM_API_KEY or KTV_LLM_API_KEY.
  --llm-model <model>   Chat model name. Defaults to LLM_MODEL or KTV_LLM_MODEL.
`;
}
