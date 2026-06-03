import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import type { QueryExecutor } from "../db/query-executor.js";
import {
  buildKtvIndexAssetDraft,
  indexKtvAssetDrafts,
  type IndexKtvAssetDraftsInput,
  type IndexKtvAssetDraftsResult
} from "../modules/ingest/ktv-full-index.js";
import type { KtvSampleSourceFile } from "../modules/ingest/ktv-sample-index.js";

export interface KtvFullIndexCliOptions {
  sourceRoot: string;
  sshHost?: string | undefined;
  databaseUrl?: string | undefined;
  limit?: number | undefined;
  preserveExisting: boolean;
  help: boolean;
}

interface DbClient extends QueryExecutor {
  connect?(): Promise<unknown>;
  end(): Promise<void>;
}

export interface RunKtvFullIndexCliDependencies {
  createDbClient?: (databaseUrl: string) => DbClient;
  discoverMediaFiles?: (options: KtvFullIndexCliOptions) => Promise<KtvSampleSourceFile[]>;
  env?: Record<string, string | undefined>;
  indexAssetDrafts?: (db: QueryExecutor, input: IndexKtvAssetDraftsInput) => Promise<IndexKtvAssetDraftsResult>;
  stdout?: (line: string) => void;
}

const DEFAULT_SOURCE_ROOT = "/mnt/nas/KTV歌曲";
const MEDIA_FIND_EXPR = "\\( -iname '*.mkv' -o -iname '*.mpg' -o -iname '*.mpeg' \\)";

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  runKtvFullIndexCli(process.argv.slice(2)).then((exitCode) => {
    process.exit(exitCode);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export async function runKtvFullIndexCli(
  argv: readonly string[],
  dependencies: RunKtvFullIndexCliDependencies = {}
): Promise<number> {
  const options = parseKtvFullIndexCliOptions(argv, dependencies.env ?? process.env);
  const stdout = dependencies.stdout ?? console.log;

  if (options.help) {
    stdout(usage());
    return 0;
  }

  if (!options.databaseUrl) {
    throw new Error("DATABASE_URL or --database-url is required for full KTV indexing");
  }

  const sourceFiles = await (dependencies.discoverMediaFiles ?? discoverMediaFiles)(options);
  const limitedFiles = options.limit ? sourceFiles.slice(0, options.limit) : sourceFiles;
  const drafts = limitedFiles.map(buildKtvIndexAssetDraft);
  const db = (dependencies.createDbClient ?? createPgClient)(options.databaseUrl);
  await db.connect?.();

  try {
    const result = await (dependencies.indexAssetDrafts ?? indexKtvAssetDrafts)(db, {
      sourceRoot: options.sourceRoot,
      sshHost: options.sshHost,
      drafts,
      markMissingAssets: !options.limit,
      preserveExisting: options.preserveExisting
    });
    printSummary({
      sourceFileCount: sourceFiles.length,
      result,
      stdout
    });
    return 0;
  } finally {
    await db.end();
  }
}

export function parseKtvFullIndexCliOptions(
  args: readonly string[],
  env: Record<string, string | undefined> = process.env
): KtvFullIndexCliOptions {
  const options: KtvFullIndexCliOptions = {
    sourceRoot: DEFAULT_SOURCE_ROOT,
    databaseUrl: clean(env.DATABASE_URL),
    preserveExisting: false,
    help: false
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
      case "--source-root":
        options.sourceRoot = requireValue(args, index, arg);
        index += 1;
        break;
      case "--ssh-host":
        options.sshHost = requireValue(args, index, arg);
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
      case "--preserve-existing":
        options.preserveExisting = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

async function discoverMediaFiles(options: KtvFullIndexCliOptions): Promise<KtvSampleSourceFile[]> {
  const command = `find ${shellQuote(options.sourceRoot)} -type f ${MEDIA_FIND_EXPR} -printf '%p\\t%s\\t%T@\\0'`;
  const stdout = options.sshHost
    ? await runCommand("ssh", [options.sshHost, command])
    : await runCommand("sh", ["-lc", command]);
  const normalizedRoot = trimTrailingSlash(options.sourceRoot.replaceAll("\\", "/"));

  return stdout.toString("utf8")
    .split("\0")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => parseFindRecord(record, normalizedRoot))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function createPgClient(databaseUrl: string): DbClient {
  return new Client({ connectionString: databaseUrl });
}

function printSummary(input: {
  sourceFileCount: number;
  result: IndexKtvAssetDraftsResult;
  stdout: (line: string) => void;
}): void {
  input.stdout(`KTV index run id: ${input.result.runId}`);
  input.stdout(`Discovered media files: ${input.sourceFileCount}`);
  input.stdout(`Indexed files: ${input.result.filesSeen}`);
  input.stdout(`Songs upserted: ${input.result.songsUpserted}`);
  input.stdout(`Assets upserted: ${input.result.assetsUpserted}`);
  input.stdout(`Assets marked missing: ${input.result.assetsMarkedMissing}`);
}

function parseFindRecord(record: string, normalizedRoot: string): KtvSampleSourceFile {
  const [rawPath, rawSize, rawMtime] = record.split("\t");
  if (!rawPath) {
    throw new Error(`Invalid find record: ${record}`);
  }

  const sourcePath = rawPath.replaceAll("\\", "/");
  const relativePath = sourcePath.startsWith(`${normalizedRoot}/`)
    ? sourcePath.slice(normalizedRoot.length + 1)
    : sourcePath;
  const parsedSize = rawSize ? Number.parseInt(rawSize, 10) : Number.NaN;
  const parsedMtimeSeconds = rawMtime ? Number.parseFloat(rawMtime) : Number.NaN;

  return {
    sourcePath,
    relativePath,
    sizeBytes: Number.isFinite(parsedSize) ? parsedSize : null,
    mtimeMs: Number.isFinite(parsedMtimeSeconds) ? Math.trunc(parsedMtimeSeconds * 1000) : null
  };
}

async function runCommand(command: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve(Buffer.concat(stdoutChunks));
        return;
      }

      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      reject(new Error(`Command failed: ${command} ${args.join(" ")} (${signal ?? code})${stderr ? `\n${stderr}` : ""}`));
    });
  });
}

function requireValue(args: readonly string[], index: number, arg: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${arg} requires a value`);
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function usage(): string {
  return `Usage:
  pnpm -F @home-ktv/api index:ktv -- --ssh-host lxc-nas --source-root /mnt/nas/KTV歌曲 --database-url postgresql://ktv:ktv@127.0.0.1:5432/home_ktv --preserve-existing

Options:
  --ssh-host <host>         SSH host that can read the media library.
  --source-root <path>      Library root. Default: ${DEFAULT_SOURCE_ROOT}
  --database-url <url>      PostgreSQL URL. Defaults to DATABASE_URL.
  --limit <count>           Optional smoke-test limit.
  --preserve-existing       Keep same-path metadata/tags/probe data and only refresh existence + file stats.
`;
}
