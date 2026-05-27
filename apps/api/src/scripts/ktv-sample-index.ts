import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";
import {
  buildKtvSampleReportMarkdown,
  buildKtvSampleRow,
  pickRandomSample,
  type KtvSampleRow,
  type KtvSampleSourceFile
} from "../modules/ingest/ktv-sample-index.js";

interface CliOptions {
  sourceRoot: string;
  sampleSize: number;
  sshHost?: string | undefined;
  databaseUrl?: string | undefined;
  reportPath: string;
  help: boolean;
}

interface PersistSampleRunInput {
  client: Client;
  sourceRoot: string;
  sshHost?: string | undefined;
  totalFiles: number;
  sampleSize: number;
  rows: readonly KtvSampleRow[];
}

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const DEFAULT_SOURCE_ROOT = "/mnt/nas/KTV歌曲";
const DEFAULT_SAMPLE_SIZE = 200;
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

  const discoveredPaths = await discoverMediaPaths(options);
  if (discoveredPaths.length === 0) {
    throw new Error(`No supported media files were discovered under ${options.sourceRoot}`);
  }

  const sampledPaths = pickRandomSample(discoveredPaths, options.sampleSize);
  const rows = sampledPaths.map((sourcePath) => buildKtvSampleRow(toSourceFile(sourcePath, options.sourceRoot)));
  const databaseRunId = options.databaseUrl
    ? await persistSampleRun({
        client: new Client({ connectionString: options.databaseUrl }),
        sourceRoot: options.sourceRoot,
        sshHost: options.sshHost,
        totalFiles: discoveredPaths.length,
        sampleSize: options.sampleSize,
        rows
      })
    : null;

  const report = buildKtvSampleReportMarkdown({
    sourceRoot: options.sourceRoot,
    sshHost: options.sshHost,
    databaseRunId,
    totalFiles: discoveredPaths.length,
    sampleSize: options.sampleSize,
    rows
  });

  await mkdir(path.dirname(options.reportPath), { recursive: true });
  await writeFile(options.reportPath, report, "utf8");

  console.log(`Discovered media files: ${discoveredPaths.length}`);
  console.log(`Sample rows: ${rows.length}`);
  if (databaseRunId) {
    console.log(`Database run id: ${databaseRunId}`);
  } else {
    console.log("Database insert skipped: no DATABASE_URL or --database-url was provided");
  }
  console.log(`Report: ${options.reportPath}`);
}

async function discoverMediaPaths(options: CliOptions): Promise<string[]> {
  const command = `find ${shellQuote(options.sourceRoot)} -type f ${MEDIA_FIND_EXPR} -print0`;
  const stdout = options.sshHost
    ? await runCommand("ssh", [options.sshHost, command])
    : await runCommand("sh", ["-lc", command]);

  const paths = stdout.toString("utf8").split("\0").map((item) => item.trim()).filter(Boolean);
  return Array.from(new Set(paths)).sort((left, right) => left.localeCompare(right));
}

function toSourceFile(sourcePath: string, sourceRoot: string): KtvSampleSourceFile {
  const normalizedSourcePath = sourcePath.replaceAll("\\", "/");
  const normalizedRoot = trimTrailingSlash(sourceRoot.replaceAll("\\", "/"));
  const relativePath = normalizedSourcePath.startsWith(`${normalizedRoot}/`)
    ? normalizedSourcePath.slice(normalizedRoot.length + 1)
    : normalizedSourcePath;

  return {
    sourcePath: normalizedSourcePath,
    relativePath,
    sizeBytes: null,
    mtimeMs: null
  };
}

async function persistSampleRun(input: PersistSampleRunInput): Promise<string> {
  await input.client.connect();
  try {
    await ensureSampleTables(input.client);
    await input.client.query("BEGIN");
    try {
      const runResult = await input.client.query<{ id: string }>(
        `INSERT INTO ktv_sample_parse_runs (
           source_root, ssh_host, total_files, sample_size
         )
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [input.sourceRoot, input.sshHost ?? null, input.totalFiles, input.sampleSize]
      );
      const runId = requireRow(runResult.rows[0], "ktv_sample_parse_runs insert").id;

      for (const row of input.rows) {
        await input.client.query(
          `INSERT INTO ktv_sample_parse_files (
             run_id, source_path, relative_path, file_name, extension,
             title, artist_name, category, parse_strategy, parse_confidence,
             parse_notes, size_bytes, mtime_ms
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
           ON CONFLICT (run_id, source_path)
           DO UPDATE SET
             relative_path = EXCLUDED.relative_path,
             file_name = EXCLUDED.file_name,
             extension = EXCLUDED.extension,
             title = EXCLUDED.title,
             artist_name = EXCLUDED.artist_name,
             category = EXCLUDED.category,
             parse_strategy = EXCLUDED.parse_strategy,
             parse_confidence = EXCLUDED.parse_confidence,
             parse_notes = EXCLUDED.parse_notes,
             size_bytes = EXCLUDED.size_bytes,
             mtime_ms = EXCLUDED.mtime_ms,
             updated_at = now()`,
          [
            runId,
            row.sourcePath,
            row.relativePath,
            row.fileName,
            row.extension,
            row.title,
            row.artistName,
            row.category,
            row.parseStrategy,
            row.parseConfidence,
            JSON.stringify(row.parseNotes),
            row.sizeBytes,
            row.mtimeMs
          ]
        );
      }

      await input.client.query("COMMIT");
      return runId;
    } catch (error) {
      await input.client.query("ROLLBACK");
      throw error;
    }
  } finally {
    await input.client.end();
  }
}

async function ensureSampleTables(client: Client): Promise<void> {
  await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
  await client.query(`
    CREATE TABLE IF NOT EXISTS ktv_sample_parse_runs (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      source_root text NOT NULL,
      ssh_host text,
      total_files integer NOT NULL CHECK (total_files >= 0),
      sample_size integer NOT NULL CHECK (sample_size >= 0),
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ktv_sample_parse_files (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      run_id text NOT NULL REFERENCES ktv_sample_parse_runs(id) ON DELETE CASCADE,
      source_path text NOT NULL,
      relative_path text NOT NULL,
      file_name text NOT NULL,
      extension text NOT NULL,
      title text NOT NULL,
      artist_name text NOT NULL,
      category text,
      parse_strategy text NOT NULL CHECK (parse_strategy IN ('filename', 'path', 'hybrid', 'fallback')),
      parse_confidence numeric(4,3) NOT NULL CHECK (parse_confidence >= 0 AND parse_confidence <= 1),
      parse_notes jsonb NOT NULL DEFAULT '[]'::jsonb,
      size_bytes bigint,
      mtime_ms bigint,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (run_id, source_path)
    )
  `);
  await client.query("CREATE INDEX IF NOT EXISTS ktv_sample_parse_files_run_idx ON ktv_sample_parse_files(run_id)");
  await client.query("CREATE INDEX IF NOT EXISTS ktv_sample_parse_files_title_idx ON ktv_sample_parse_files(lower(title))");
  await client.query("CREATE INDEX IF NOT EXISTS ktv_sample_parse_files_artist_idx ON ktv_sample_parse_files(lower(artist_name))");
  await client.query("CREATE INDEX IF NOT EXISTS ktv_sample_parse_files_category_idx ON ktv_sample_parse_files(category)");
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
    sampleSize: DEFAULT_SAMPLE_SIZE,
    databaseUrl: process.env.DATABASE_URL?.trim() || undefined,
    reportPath: path.join(ROOT_DIR, "docs", "reports", `ktv-sample-index-${timestampForFile(new Date())}.md`),
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
      case "--sample-size":
        options.sampleSize = parsePositiveInteger(requireValue(args, index, arg), "--sample-size");
        index += 1;
        break;
      case "--database-url":
        options.databaseUrl = requireValue(args, index, arg);
        index += 1;
        break;
      case "--report-path":
        options.reportPath = path.resolve(requireValue(args, index, arg));
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

function timestampForFile(value: Date): string {
  return value.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function requireRow<TRow>(row: TRow | undefined, context: string): TRow {
  if (!row) {
    throw new Error(`${context} did not return a row`);
  }
  return row;
}

function printUsage(): void {
  console.log(`Usage:
  pnpm -F @home-ktv/api sample:ktv-index -- --ssh-host lxc-nas --source-root /mnt/nas/KTV歌曲 --database-url postgresql://ktv:ktv@127.0.0.1:5432/home_ktv

Options:
  --ssh-host <host>       SSH host that can read the media library.
  --source-root <path>    Library root. Default: ${DEFAULT_SOURCE_ROOT}
  --sample-size <count>   Number of files to sample. Default: ${DEFAULT_SAMPLE_SIZE}
  --database-url <url>    PostgreSQL URL. Defaults to DATABASE_URL.
  --report-path <path>    Markdown report output path.
`);
}
