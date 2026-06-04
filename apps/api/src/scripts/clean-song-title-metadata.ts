import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import type { QueryExecutor } from "../db/query-executor.js";
import { buildPinyinSearchKeys, normalizeSearchText } from "../modules/catalog/search-normalization.js";
import { buildKtvIndexAssetDraft } from "../modules/ingest/ktv-full-index.js";
import { cleanSongTitle } from "../modules/ingest/song-title-cleanup.js";

interface KtvSongRow {
  id: string;
  title: string;
  normalized_title: string;
  primary_artist_name: string;
  normalized_primary_artist_name?: string | undefined;
  artist_names: string[] | null;
  file_path?: string | undefined;
  relative_path: string;
  file_name?: string | undefined;
  extension?: string | undefined;
  size_bytes?: number | string | null | undefined;
  mtime_ms?: number | string | null | undefined;
  parse_strategy?: string | undefined;
  parse_confidence?: number | string | undefined;
}

interface DbClient extends QueryExecutor {
  connect?(): Promise<unknown>;
  end(): Promise<void>;
}

export interface CleanSongTitleMetadataOptions {
  apply: boolean;
  databaseUrl: string | undefined;
  help: boolean;
  limit: number | undefined;
}

export interface RunCleanSongTitleMetadataDependencies {
  createDbClient?: (databaseUrl: string) => DbClient;
  env?: Record<string, string | undefined>;
  stdout?: (line: string) => void;
}

export interface SongTitleCleanupPlanItem {
  id: string;
  title: string;
  normalizedTitle: string;
  previousTitle: string;
  previousNormalizedTitle: string;
  primaryArtistName: string;
  normalizedPrimaryArtistName: string;
  artistNames: string[];
  previousPrimaryArtistName: string;
  previousNormalizedPrimaryArtistName: string;
  previousArtistNames: string[];
  reasons: string[];
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  runCleanSongTitleMetadataCli(process.argv.slice(2)).then((exitCode) => {
    process.exit(exitCode);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export async function runCleanSongTitleMetadataCli(
  argv: readonly string[],
  dependencies: RunCleanSongTitleMetadataDependencies = {}
): Promise<number> {
  const options = parseCleanSongTitleMetadataOptions(argv, dependencies.env ?? process.env);
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
    const plan = buildSongTitleCleanupPlan(rows);
    if (options.apply) {
      await applySongTitleCleanupPlan(db, plan);
    }
    stdout(JSON.stringify(buildSummary(plan, options.apply), null, 2));
    return 0;
  } finally {
    await db.end();
  }
}

export function parseCleanSongTitleMetadataOptions(
  args: readonly string[],
  env: Record<string, string | undefined> = process.env
): CleanSongTitleMetadataOptions {
  const options: CleanSongTitleMetadataOptions = {
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

export function buildSongTitleCleanupPlan(rows: readonly KtvSongRow[]): SongTitleCleanupPlanItem[] {
  return rows.flatMap((row): SongTitleCleanupPlanItem[] => {
    const reparsed = buildKtvIndexAssetDraft({
      sourcePath: row.file_path ?? row.relative_path,
      relativePath: row.relative_path,
      sizeBytes: toNullableNumber(row.size_bytes ?? null),
      mtimeMs: toNullableNumber(row.mtime_ms ?? null)
    });
    const cleanedTitle = cleanSongTitle({ title: reparsed.title || row.title });
    const normalizedTitle = normalizeSearchText(cleanedTitle.title);
    const shouldUpdateArtist = shouldUpdateArtistFromPath(row, reparsed.artistNames);
    const primaryArtistName = shouldUpdateArtist
      ? (reparsed.artistNames[0] ?? row.primary_artist_name)
      : row.primary_artist_name;
    const normalizedPrimaryArtistName = normalizeSearchText(primaryArtistName);
    const artistNames = shouldUpdateArtist && reparsed.artistNames.length
      ? reparsed.artistNames
      : (row.artist_names ?? [row.primary_artist_name]);
    const previousArtistNames = row.artist_names ?? [];
    const reasons = new Set(cleanedTitle.reasons);

    if (cleanedTitle.title !== row.title) {
      reasons.add("title-from-path");
    }
    if (normalizedTitle !== row.normalized_title) {
      reasons.add("normalized-title");
    }
    if (shouldUpdateArtist && (primaryArtistName !== row.primary_artist_name || !sameStringArray(artistNames, previousArtistNames))) {
      reasons.add("artist-from-path");
    }

    if (
      cleanedTitle.title === row.title
      && normalizedTitle === row.normalized_title
      && primaryArtistName === row.primary_artist_name
      && normalizedPrimaryArtistName === (row.normalized_primary_artist_name ?? normalizeSearchText(row.primary_artist_name))
      && sameStringArray(artistNames, previousArtistNames)
    ) {
      return [];
    }

    return [{
      id: row.id,
      title: cleanedTitle.title,
      normalizedTitle,
      previousTitle: row.title,
      previousNormalizedTitle: row.normalized_title,
      primaryArtistName,
      normalizedPrimaryArtistName,
      artistNames,
      previousPrimaryArtistName: row.primary_artist_name,
      previousNormalizedPrimaryArtistName: row.normalized_primary_artist_name ?? normalizeSearchText(row.primary_artist_name),
      previousArtistNames,
      reasons: Array.from(reasons)
    }];
  });
}

async function selectCandidateRows(db: QueryExecutor, limit: number | undefined): Promise<KtvSongRow[]> {
  const limitSql = limit ? "LIMIT $1" : "";
  const values = limit ? [limit] : [];
  const result = await db.query<KtvSongRow>(
    `SELECT id, title, normalized_title,
            primary_artist_name, normalized_primary_artist_name, artist_names,
            file_path, relative_path, file_name, extension,
            size_bytes, mtime_ms, parse_strategy, parse_confidence
     FROM ktv_songs
     WHERE missing_at IS NULL
     ORDER BY relative_path ASC, id ASC
     ${limitSql}`,
    values
  );
  return result.rows;
}

async function applySongTitleCleanupPlan(db: QueryExecutor, plan: readonly SongTitleCleanupPlanItem[]): Promise<void> {
  for (const item of plan) {
    const titleKeys = buildPinyinSearchKeys(item.title);
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
        item.normalizedTitle,
        titleKeys.pinyin,
        titleKeys.initials,
        item.primaryArtistName,
        item.normalizedPrimaryArtistName,
        item.artistNames
      ]
    );
  }
}

function buildSummary(plan: readonly SongTitleCleanupPlanItem[], applied: boolean): Record<string, unknown> {
  const reasonCounts = new Map<string, number>();
  for (const item of plan) {
    for (const reason of item.reasons) {
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    }
  }

  return {
    applied,
    changedSongs: plan.length,
    titleChanges: plan.filter((item) => item.title !== item.previousTitle).length,
    normalizedTitleChanges: plan.filter((item) => item.normalizedTitle !== item.previousNormalizedTitle).length,
    artistChanges: plan.filter((item) => (
      item.primaryArtistName !== item.previousPrimaryArtistName
      || item.normalizedPrimaryArtistName !== item.previousNormalizedPrimaryArtistName
      || !sameStringArray(item.artistNames, item.previousArtistNames)
    )).length,
    reasonCounts: Object.fromEntries([...reasonCounts.entries()].sort(([left], [right]) => left.localeCompare(right))),
    examples: plan.slice(0, 30).map((item) => ({
      id: item.id,
      title: { before: item.previousTitle, after: item.title },
      normalizedTitle: { before: item.previousNormalizedTitle, after: item.normalizedTitle },
      primaryArtistName: { before: item.previousPrimaryArtistName, after: item.primaryArtistName },
      artistNames: { before: item.previousArtistNames, after: item.artistNames },
      reasons: item.reasons
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

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function toNullableNumber(value: number | string | null): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function shouldUpdateArtistFromPath(row: KtvSongRow, parsedArtistNames: readonly string[]): boolean {
  const parsedPrimaryArtistName = parsedArtistNames[0]?.trim();
  if (!parsedPrimaryArtistName || parsedPrimaryArtistName === "Unknown Artist") {
    return false;
  }

  const currentPrimaryArtistName = row.primary_artist_name.trim();
  if (!currentPrimaryArtistName || currentPrimaryArtistName === "Unknown Artist") {
    return true;
  }

  const currentNormalized = row.normalized_primary_artist_name ?? normalizeSearchText(currentPrimaryArtistName);
  const parsedNormalized = normalizeSearchText(parsedPrimaryArtistName);
  if (currentNormalized !== parsedNormalized) {
    return true;
  }

  return isFolderLikeArtistName(currentPrimaryArtistName);
}

function isFolderLikeArtistName(value: string): boolean {
  return /^(2024|2025|经典老歌|经曲老歌|推荐|K歌排行|k歌排行|\d+)$/u.test(value.trim());
}

function usage(): string {
  return `Usage: pnpm -F @home-ktv/api clean:song-title-metadata -- --database-url <url> [--apply] [--limit N]

Clean ktv_songs titles and recompute normalized title/pinyin fields.
Without --apply this command prints a dry-run summary only.`;
}
