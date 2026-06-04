import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import type { QueryExecutor } from "../db/query-executor.js";
import { buildPinyinSearchKeys, normalizeSearchText } from "../modules/catalog/search-normalization.js";
import {
  cleanKtvSongVarietyMetadata,
  type KtvSongVarietyMetadataCleanResult
} from "../modules/ingest/variety-show-metadata.js";

interface KtvSongRow {
  id: string;
  title: string;
  primary_artist_name: string;
  artist_names: string[] | null;
  relative_path: string;
}

interface DbClient extends QueryExecutor {
  connect?(): Promise<unknown>;
  end(): Promise<void>;
}

export interface CleanVarietyShowMetadataOptions {
  apply: boolean;
  databaseUrl: string | undefined;
  help: boolean;
  limit: number | undefined;
}

export interface RunCleanVarietyShowMetadataDependencies {
  createDbClient?: (databaseUrl: string) => DbClient;
  env?: Record<string, string | undefined>;
  stdout?: (line: string) => void;
}

interface CleanupPlanItem extends KtvSongVarietyMetadataCleanResult {
  previousTitle: string;
  previousPrimaryArtistName: string;
  previousArtistNames: string[];
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  runCleanVarietyShowMetadataCli(process.argv.slice(2)).then((exitCode) => {
    process.exit(exitCode);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export async function runCleanVarietyShowMetadataCli(
  argv: readonly string[],
  dependencies: RunCleanVarietyShowMetadataDependencies = {}
): Promise<number> {
  const options = parseCleanVarietyShowMetadataOptions(argv, dependencies.env ?? process.env);
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
    const rows = await selectCandidateRows(db, options.limit);
    const plan = buildCleanupPlan(rows);
    if (options.apply) {
      await applyCleanupPlan(db, plan);
    }
    stdout(JSON.stringify(buildSummary(plan, options.apply), null, 2));
    return 0;
  } finally {
    await db.end();
  }
}

export function parseCleanVarietyShowMetadataOptions(
  args: readonly string[],
  env: Record<string, string | undefined> = process.env
): CleanVarietyShowMetadataOptions {
  const options: CleanVarietyShowMetadataOptions = {
    apply: false,
    databaseUrl: clean(env.DATABASE_URL),
    help: false,
    limit: undefined
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

export function buildCleanupPlan(rows: readonly KtvSongRow[]): CleanupPlanItem[] {
  return rows
    .map((row): CleanupPlanItem => {
      const previousArtistNames = row.artist_names ?? [];
      const cleaned = cleanKtvSongVarietyMetadata({
        id: row.id,
        title: row.title,
        primaryArtistName: row.primary_artist_name,
        artistNames: previousArtistNames,
        relativePath: row.relative_path
      });
      return {
        ...cleaned,
        previousTitle: row.title,
        previousPrimaryArtistName: row.primary_artist_name,
        previousArtistNames
      };
    })
    .filter((item) => item.changed);
}

async function selectCandidateRows(db: QueryExecutor, limit: number | undefined): Promise<KtvSongRow[]> {
  const limitSql = limit ? "LIMIT $1" : "";
  const values = limit ? [limit] : [];
  const result = await db.query<KtvSongRow>(
    `SELECT id, title, primary_artist_name, artist_names, relative_path
     FROM ktv_songs
     WHERE missing_at IS NULL
     ORDER BY relative_path ASC, id ASC
     ${limitSql}`,
    values
  );
  return result.rows;
}

async function applyCleanupPlan(db: QueryExecutor, plan: readonly CleanupPlanItem[]): Promise<void> {
  for (const item of plan) {
    const titleKeys = buildPinyinSearchKeys(item.title);
    const normalizedPrimaryArtistName = normalizeSearchText(item.primaryArtistName);
    await db.query(
      `UPDATE ktv_songs
       SET title = $2,
           normalized_title = $3,
           title_pinyin = $4,
           title_initials = $5,
           primary_artist_name = $6,
           normalized_primary_artist_name = $7,
           artist_names = $8::text[],
           updated_at = now()
       WHERE id = $1`,
      [
        item.id,
        item.title,
        normalizeSearchText(item.title),
        titleKeys.pinyin,
        titleKeys.initials,
        item.primaryArtistName,
        normalizedPrimaryArtistName,
        item.artistNames
      ]
    );
  }
}

function buildSummary(plan: readonly CleanupPlanItem[], applied: boolean): Record<string, unknown> {
  return {
    applied,
    changedSongs: plan.length,
    titleChanges: plan.filter((item) => item.title !== item.previousTitle).length,
    artistChanges: plan.filter((item) => (
      item.primaryArtistName !== item.previousPrimaryArtistName
      || item.artistNames.join("\u0000") !== item.previousArtistNames.join("\u0000")
    )).length,
    examples: plan.slice(0, 20).map((item) => ({
      id: item.id,
      title: { before: item.previousTitle, after: item.title },
      primaryArtistName: { before: item.previousPrimaryArtistName, after: item.primaryArtistName },
      artistNames: { before: item.previousArtistNames, after: item.artistNames }
    }))
  };
}

function createPgClient(databaseUrl: string): DbClient {
  return new Client({ connectionString: databaseUrl });
}

function requireValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function clean(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text || undefined;
}

function usage(): string {
  return `Usage: pnpm -F @home-ktv/api clean:variety-show-metadata -- --database-url <url> [--apply] [--limit N]

Clean variety show names from ktv_songs artist_names and strip variety show markers from titles.
Without --apply this command prints a dry-run summary only.`;
}
