import path from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import type { QueryExecutor } from "../db/query-executor.js";
import { exportStyleTaggingSongsJsonl } from "../modules/ktv-index/style-tagging-jsonl.js";

export interface KtvStyleTagsExportCliOptions {
  databaseUrl: string | undefined;
  help: boolean;
  limit: number | undefined;
  outPath: string;
}

interface DbClient extends QueryExecutor {
  end(): Promise<void>;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  runKtvStyleTagsExportCli(process.argv.slice(2)).then((exitCode) => {
    process.exit(exitCode);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export async function runKtvStyleTagsExportCli(
  argv: readonly string[],
  dependencies: {
    createDbClient?: (databaseUrl: string) => DbClient;
    env?: Record<string, string | undefined>;
    stdout?: (line: string) => void;
  } = {}
): Promise<number> {
  const options = parseKtvStyleTagsExportCliOptions(argv, dependencies.env ?? process.env);
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
    const result = await exportStyleTaggingSongsJsonl({
      db,
      outPath: options.outPath,
      ...(options.limit === undefined ? {} : { limit: options.limit })
    });
    stdout("KTV style tagging export summary");
    stdout(`exported=${result.exported} out=${result.outPath}`);
    return 0;
  } finally {
    await db.end();
  }
}

export function parseKtvStyleTagsExportCliOptions(
  args: readonly string[],
  env: Record<string, string | undefined> = process.env
): KtvStyleTagsExportCliOptions {
  const options: KtvStyleTagsExportCliOptions = {
    databaseUrl: clean(env.DATABASE_URL),
    help: false,
    limit: undefined,
    outPath: ""
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
      case "--database-url":
        options.databaseUrl = requireValue(args, index, arg);
        index += 1;
        break;
      case "--out":
      case "--output":
        options.outPath = requireValue(args, index, arg);
        index += 1;
        break;
      case "--limit":
        options.limit = parsePositiveInteger(requireValue(args, index, arg), arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.help && options.outPath.length === 0) {
    throw new Error("--out is required");
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
  pnpm -F @home-ktv/api tag:ktv-styles:export -- --out runtime/media/tagging/full/songs.jsonl

Options:
  --out <path>          Output JSONL path.
  --limit <count>      Optional number of active songs to export.
  --database-url <url> PostgreSQL URL. Defaults to DATABASE_URL.
`;
}
