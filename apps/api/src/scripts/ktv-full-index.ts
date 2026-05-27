import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";
import {
  buildKtvIndexAssetDraft,
  indexKtvAssetDrafts,
  type KtvIndexAssetDraft
} from "../modules/ingest/ktv-full-index.js";
import type { KtvSampleSourceFile } from "../modules/ingest/ktv-sample-index.js";

interface CliOptions {
  sourceRoot: string;
  sshHost?: string | undefined;
  databaseUrl?: string | undefined;
  limit?: number | undefined;
  help: boolean;
}

const DEFAULT_SOURCE_ROOT = "/mnt/nas/KTV歌曲";
const MEDIA_FIND_EXPR = "\\( -iname '*.mkv' -o -iname '*.mpg' -o -iname '*.mpeg' \\)";

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  if (!options.databaseUrl) {
    throw new Error("DATABASE_URL or --database-url is required for full KTV indexing");
  }

  const sourceFiles = await discoverMediaFiles(options);
  const limitedFiles = options.limit ? sourceFiles.slice(0, options.limit) : sourceFiles;
  const drafts = limitedFiles.map(buildKtvIndexAssetDraft);
  const client = new Client({ connectionString: options.databaseUrl });
  await client.connect();
  try {
    const result = await indexKtvAssetDrafts(client, {
      sourceRoot: options.sourceRoot,
      sshHost: options.sshHost,
      drafts,
      markMissingAssets: !options.limit
    });
    console.log(`KTV index run id: ${result.runId}`);
    console.log(`Discovered media files: ${sourceFiles.length}`);
    console.log(`Indexed files: ${result.filesSeen}`);
    console.log(`Songs upserted: ${result.songsUpserted}`);
    console.log(`Assets upserted: ${result.assetsUpserted}`);
    console.log(`Assets marked missing: ${result.assetsMarkedMissing}`);
  } finally {
    await client.end();
  }
}

async function discoverMediaFiles(options: CliOptions): Promise<KtvSampleSourceFile[]> {
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

function parseCliOptions(args: string[]): CliOptions {
  const options: CliOptions = {
    sourceRoot: DEFAULT_SOURCE_ROOT,
    databaseUrl: process.env.DATABASE_URL?.trim() || undefined,
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
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function requireValue(args: string[], index: number, arg: string): string {
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function printUsage(): void {
  console.log(`Usage:
  pnpm -F @home-ktv/api index:ktv -- --ssh-host lxc-nas --source-root /mnt/nas/KTV歌曲 --database-url postgresql://ktv:ktv@127.0.0.1:5432/home_ktv

Options:
  --ssh-host <host>       SSH host that can read the media library.
  --source-root <path>    Library root. Default: ${DEFAULT_SOURCE_ROOT}
  --database-url <url>    PostgreSQL URL. Defaults to DATABASE_URL.
  --limit <count>         Optional smoke-test limit.
`);
}
