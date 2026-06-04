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

export interface KtvSongImportCliOptions {
  importRoot: string;
  libraryRoot: string;
  sshHost?: string | undefined;
  databaseUrl?: string | undefined;
  limit?: number | undefined;
  overwriteExisting: boolean;
  preserveExisting: boolean;
  help: boolean;
}

interface DbClient extends QueryExecutor {
  connect?(): Promise<unknown>;
  end(): Promise<void>;
}

export interface RunKtvSongImportCliDependencies {
  createDbClient?: (databaseUrl: string) => DbClient;
  discoverMediaFiles?: (options: KtvSongImportCliOptions) => Promise<KtvSampleSourceFile[]>;
  env?: Record<string, string | undefined>;
  indexAssetDrafts?: (db: QueryExecutor, input: IndexKtvAssetDraftsInput) => Promise<IndexKtvAssetDraftsResult>;
  stdout?: (line: string) => void;
}

const DEFAULT_LIBRARY_ROOT = "/mnt/nas/KTV歌曲";
const MEDIA_FIND_EXPR = "\\( -iname '*.mkv' -o -iname '*.mpg' -o -iname '*.mpeg' \\)";

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  runKtvSongImportCli(process.argv.slice(2)).then((exitCode) => {
    process.exit(exitCode);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export async function runKtvSongImportCli(
  argv: readonly string[],
  dependencies: RunKtvSongImportCliDependencies = {}
): Promise<number> {
  const options = parseKtvSongImportCliOptions(argv, dependencies.env ?? process.env);
  const stdout = dependencies.stdout ?? console.log;

  if (options.help) {
    stdout(usage());
    return 0;
  }

  if (!options.databaseUrl) {
    throw new Error("DATABASE_URL or --database-url is required for KTV song import");
  }

  validateImportRoot(options.importRoot, options.libraryRoot);
  const sourceFiles = await (dependencies.discoverMediaFiles ?? discoverMediaFiles)(options);
  const limitedFiles = options.limit ? sourceFiles.slice(0, options.limit) : sourceFiles;
  const drafts = limitedFiles.map(buildKtvIndexAssetDraft);
  const db = (dependencies.createDbClient ?? createPgClient)(options.databaseUrl);
  await db.connect?.();

  try {
    const result = await (dependencies.indexAssetDrafts ?? indexKtvAssetDrafts)(db, {
      sourceRoot: options.libraryRoot,
      sshHost: options.sshHost,
      drafts,
      markMissingAssets: false,
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

export function parseKtvSongImportCliOptions(
  args: readonly string[],
  env: Record<string, string | undefined> = process.env
): KtvSongImportCliOptions {
  const options: KtvSongImportCliOptions = {
    importRoot: "",
    libraryRoot: DEFAULT_LIBRARY_ROOT,
    databaseUrl: clean(env.DATABASE_URL),
    overwriteExisting: false,
    preserveExisting: true,
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
      case "--import-root":
        options.importRoot = requireValue(args, index, arg);
        index += 1;
        break;
      case "--library-root":
        options.libraryRoot = requireValue(args, index, arg);
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
      case "--overwrite-existing":
        options.overwriteExisting = true;
        options.preserveExisting = false;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.help && !options.importRoot) {
    throw new Error("--import-root is required");
  }

  return options;
}

async function discoverMediaFiles(options: KtvSongImportCliOptions): Promise<KtvSampleSourceFile[]> {
  const normalizedImportRoot = trimTrailingSlash(options.importRoot.replaceAll("\\", "/"));
  const normalizedLibraryRoot = trimTrailingSlash(options.libraryRoot.replaceAll("\\", "/"));
  const command = `find ${shellQuote(normalizedImportRoot)} -type f ${MEDIA_FIND_EXPR} -printf '%p\\t%s\\t%T@\\0'`;
  const stdout = options.sshHost
    ? await runCommand("ssh", [options.sshHost, command])
    : await runCommand("sh", ["-lc", command]);

  return stdout.toString("utf8")
    .split("\0")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => parseFindRecord(record, normalizedLibraryRoot))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function createPgClient(databaseUrl: string): DbClient {
  return new Client({ connectionString: databaseUrl });
}

function validateImportRoot(importRoot: string, libraryRoot: string): void {
  const normalizedImportRoot = trimTrailingSlash(importRoot.replaceAll("\\", "/"));
  const normalizedLibraryRoot = trimTrailingSlash(libraryRoot.replaceAll("\\", "/"));
  if (normalizedImportRoot === normalizedLibraryRoot || normalizedImportRoot.startsWith(`${normalizedLibraryRoot}/`)) {
    return;
  }
  throw new Error(`--import-root must be inside --library-root (${normalizedLibraryRoot})`);
}

function printSummary(input: {
  sourceFileCount: number;
  result: IndexKtvAssetDraftsResult;
  stdout: (line: string) => void;
}): void {
  input.stdout(`KTV song import run id: ${input.result.runId}`);
  input.stdout(`Discovered media files: ${input.sourceFileCount}`);
  input.stdout(`Imported files: ${input.result.filesSeen}`);
  input.stdout(`Songs upserted: ${input.result.songsUpserted}`);
  input.stdout(`Assets upserted: ${input.result.assetsUpserted}`);
  input.stdout(`Assets marked missing: ${input.result.assetsMarkedMissing}`);
}

function parseFindRecord(record: string, normalizedLibraryRoot: string): KtvSampleSourceFile {
  const [rawPath, rawSize, rawMtime] = record.split("\t");
  if (!rawPath) {
    throw new Error(`Invalid find record: ${record}`);
  }

  const sourcePath = rawPath.replaceAll("\\", "/");
  const relativePath = sourcePath.startsWith(`${normalizedLibraryRoot}/`)
    ? sourcePath.slice(normalizedLibraryRoot.length + 1)
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
  pnpm -F @home-ktv/api import:songs -- --import-root /mnt/nas/KTV歌曲/_imports/2026-06-batch --library-root /mnt/nas/KTV歌曲

Options:
  --import-root <path>       Required. Directory to import. Must be inside --library-root.
  --library-root <path>      Full NAS library root. Default: ${DEFAULT_LIBRARY_ROOT}
  --ssh-host <host>          SSH host that can read the media library.
  --database-url <url>       PostgreSQL URL. Defaults to DATABASE_URL.
  --limit <count>            Optional smoke-test limit.
  --overwrite-existing       Re-parse and overwrite same-path song metadata. Default preserves curated metadata.
`;
}
