import path from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import type { QueryExecutor } from "../db/query-executor.js";
import { importStyleTaggingJsonlResults } from "../modules/ktv-index/style-tagging-jsonl.js";

export interface KtvStyleTagsImportCliOptions {
  apply: boolean;
  databaseUrl: string | undefined;
  help: boolean;
  inputPath: string;
}

interface DbClient extends QueryExecutor {
  end(): Promise<void>;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  runKtvStyleTagsImportCli(process.argv.slice(2)).then((exitCode) => {
    process.exit(exitCode);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export async function runKtvStyleTagsImportCli(
  argv: readonly string[],
  dependencies: {
    createDbClient?: (databaseUrl: string) => DbClient;
    env?: Record<string, string | undefined>;
    stdout?: (line: string) => void;
  } = {}
): Promise<number> {
  const options = parseKtvStyleTagsImportCliOptions(argv, dependencies.env ?? process.env);
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
    const result = await importStyleTaggingJsonlResults({
      db,
      inputPath: options.inputPath,
      apply: options.apply
    });
    stdout("KTV style tagging import summary");
    stdout(`mode=${result.dryRun ? "dry-run" : "apply"} input=${options.inputPath}`);
    stdout(
      `total=${result.total} imported=${result.imported} unmatched=${result.unmatched} tagged=${result.tagged} empty=${result.empty} failed=${result.failed}`
    );
    stdout(`writtenTags=${result.writtenTags}`);
    return 0;
  } finally {
    await db.end();
  }
}

export function parseKtvStyleTagsImportCliOptions(
  args: readonly string[],
  env: Record<string, string | undefined> = process.env
): KtvStyleTagsImportCliOptions {
  const options: KtvStyleTagsImportCliOptions = {
    apply: false,
    databaseUrl: clean(env.DATABASE_URL),
    help: false,
    inputPath: ""
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
      case "--database-url":
        options.databaseUrl = requireValue(args, index, arg);
        index += 1;
        break;
      case "--input":
        options.inputPath = requireValue(args, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.help && options.inputPath.length === 0) {
    throw new Error("--input is required");
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

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed || undefined;
}

function usage(): string {
  return `Usage:
  pnpm -F @home-ktv/api tag:ktv-styles:import -- --input runtime/media/tagging/full/results.jsonl --dry-run
  pnpm -F @home-ktv/api tag:ktv-styles:import -- --input runtime/media/tagging/full/results.jsonl --apply

Options:
  --input <path>        Result JSONL path to import.
  --dry-run             Match and summarize without writing database rows. Default.
  --apply               Write tags and status rows.
  --database-url <url>  PostgreSQL URL. Defaults to DATABASE_URL.
`;
}
