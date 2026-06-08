import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import type { QueryExecutor } from "../db/query-executor.js";
import { buildPinyinSearchKeys, normalizeSearchText } from "../modules/catalog/search-normalization.js";
import { buildKtvIndexAssetDraft } from "../modules/ingest/ktv-full-index.js";

const DEFAULT_ROOTS = ["合唱歌曲", "综艺精选"] as const;

interface KtvSongMetadataRow {
  id: string;
  title: string;
  normalized_title: string;
  title_pinyin: string;
  title_initials: string;
  primary_artist_name: string;
  normalized_primary_artist_name: string;
  artist_names: string[] | null;
  file_path: string;
  relative_path: string;
  size_bytes: number | null;
  mtime_ms: number | null;
  parse_strategy: string;
  parse_confidence: number;
}

interface DbClient extends QueryExecutor {
  connect?(): Promise<unknown>;
  end(): Promise<void>;
}

export interface RepairKtvSongMetadataOptions {
  apply: boolean;
  databaseUrl: string | undefined;
  help: boolean;
  limit: number | undefined;
  requireFilenameParse: boolean;
  roots: string[];
}

export interface RunRepairKtvSongMetadataDependencies {
  createDbClient?: (databaseUrl: string) => DbClient;
  env?: Record<string, string | undefined>;
  stdout?: (line: string) => void;
}

interface RepairPlanItem {
  id: string;
  relativePath: string;
  title: string;
  normalizedTitle: string;
  titlePinyin: string;
  titleInitials: string;
  primaryArtistName: string;
  normalizedPrimaryArtistName: string;
  artistNames: string[];
  parseStrategy: string;
  parseConfidence: number;
  previousTitle: string;
  previousNormalizedTitle: string;
  previousTitlePinyin: string;
  previousTitleInitials: string;
  previousPrimaryArtistName: string;
  previousNormalizedPrimaryArtistName: string;
  previousArtistNames: string[];
  previousParseStrategy: string;
  previousParseConfidence: number;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  runRepairKtvSongMetadataCli(process.argv.slice(2)).then((exitCode) => {
    process.exit(exitCode);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export async function runRepairKtvSongMetadataCli(
  argv: readonly string[],
  dependencies: RunRepairKtvSongMetadataDependencies = {}
): Promise<number> {
  const options = parseRepairKtvSongMetadataOptions(argv, dependencies.env ?? process.env);
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
    const rows = await selectCandidateRows(db, options);
    const plan = buildRepairPlan(rows, {
      requireFilenameParse: options.requireFilenameParse
    });
    if (options.apply) {
      await applyRepairPlan(db, plan.items);
    }
    stdout(JSON.stringify(buildSummary(rows, plan, options.apply), null, 2));
    return 0;
  } finally {
    await db.end();
  }
}

export function parseRepairKtvSongMetadataOptions(
  args: readonly string[],
  env: Record<string, string | undefined> = process.env
): RepairKtvSongMetadataOptions {
  const options: RepairKtvSongMetadataOptions = {
    apply: false,
    databaseUrl: clean(env.DATABASE_URL),
    help: false,
    limit: undefined,
    requireFilenameParse: true,
    roots: []
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
      case "--root":
        options.roots.push(normalizeRoot(requireValue(args, index, arg)));
        index += 1;
        break;
      case "--allow-non-filename-parse":
        options.requireFilenameParse = false;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.roots = options.roots.length ? unique(options.roots) : [...DEFAULT_ROOTS];
  return options;
}

export function buildRepairPlan(
  rows: readonly KtvSongMetadataRow[],
  options: { requireFilenameParse: boolean } = { requireFilenameParse: true }
): { items: RepairPlanItem[]; skipped: Array<{ id: string; relativePath: string; parseStrategy: string }> } {
  const items: RepairPlanItem[] = [];
  const skipped: Array<{ id: string; relativePath: string; parseStrategy: string }> = [];

  for (const row of rows) {
    const draft = buildKtvIndexAssetDraft({
      sourcePath: row.file_path,
      relativePath: row.relative_path,
      sizeBytes: row.size_bytes,
      mtimeMs: row.mtime_ms
    });
    if (options.requireFilenameParse && draft.parseStrategy !== "filename") {
      skipped.push({ id: row.id, relativePath: row.relative_path, parseStrategy: draft.parseStrategy });
      continue;
    }

    const primaryArtistName = draft.artistNames[0] ?? "Unknown Artist";
    const titleKeys = buildPinyinSearchKeys(draft.title);
    const item: RepairPlanItem = {
      id: row.id,
      relativePath: row.relative_path,
      title: draft.title,
      normalizedTitle: normalizeSearchText(draft.title),
      titlePinyin: titleKeys.pinyin,
      titleInitials: titleKeys.initials,
      primaryArtistName,
      normalizedPrimaryArtistName: normalizeSearchText(primaryArtistName),
      artistNames: draft.artistNames,
      parseStrategy: draft.parseStrategy,
      parseConfidence: draft.parseConfidence,
      previousTitle: row.title,
      previousNormalizedTitle: row.normalized_title,
      previousTitlePinyin: row.title_pinyin,
      previousTitleInitials: row.title_initials,
      previousPrimaryArtistName: row.primary_artist_name,
      previousNormalizedPrimaryArtistName: row.normalized_primary_artist_name,
      previousArtistNames: row.artist_names ?? [],
      previousParseStrategy: row.parse_strategy,
      previousParseConfidence: row.parse_confidence
    };

    if (hasMetadataChange(item)) {
      items.push(item);
    }
  }

  return { items, skipped };
}

async function selectCandidateRows(
  db: QueryExecutor,
  options: RepairKtvSongMetadataOptions
): Promise<KtvSongMetadataRow[]> {
  const conditions = options.roots.map((_, index) => `relative_path LIKE $${index + 1}`).join(" OR ");
  const values: unknown[] = options.roots.map((root) => `${root}/%`);
  const limitSql = options.limit ? `LIMIT $${values.length + 1}` : "";
  if (options.limit) {
    values.push(options.limit);
  }

  const result = await db.query<KtvSongMetadataRow>(
    `SELECT id, title, normalized_title, title_pinyin, title_initials,
            primary_artist_name, normalized_primary_artist_name, artist_names,
            file_path, relative_path, size_bytes, mtime_ms,
            parse_strategy, parse_confidence
     FROM ktv_songs
     WHERE missing_at IS NULL
       AND (${conditions})
     ORDER BY relative_path ASC, id ASC
     ${limitSql}`,
    values
  );
  return result.rows;
}

async function applyRepairPlan(db: QueryExecutor, plan: readonly RepairPlanItem[]): Promise<void> {
  for (const item of plan) {
    await db.query(
      `UPDATE ktv_songs
       SET title = $2,
           normalized_title = $3,
           title_pinyin = $4,
           title_initials = $5,
           primary_artist_name = $6,
           normalized_primary_artist_name = $7,
           artist_names = $8::text[],
           parse_strategy = $9,
           parse_confidence = $10,
           updated_at = now()
       WHERE id = $1`,
      [
        item.id,
        item.title,
        item.normalizedTitle,
        item.titlePinyin,
        item.titleInitials,
        item.primaryArtistName,
        item.normalizedPrimaryArtistName,
        item.artistNames,
        item.parseStrategy,
        item.parseConfidence
      ]
    );
  }
}

function buildSummary(
  rows: readonly KtvSongMetadataRow[],
  plan: { items: readonly RepairPlanItem[]; skipped: ReadonlyArray<{ id: string; relativePath: string; parseStrategy: string }> },
  applied: boolean
): Record<string, unknown> {
  return {
    applied,
    scannedSongs: rows.length,
    changedSongs: plan.items.length,
    skippedNonFilenameParse: plan.skipped.length,
    titleChanges: plan.items.filter((item) => item.title !== item.previousTitle).length,
    artistChanges: plan.items.filter((item) => (
      item.primaryArtistName !== item.previousPrimaryArtistName
      || item.artistNames.join("\u0000") !== item.previousArtistNames.join("\u0000")
    )).length,
    examples: plan.items.slice(0, 20).map((item) => ({
      id: item.id,
      relativePath: item.relativePath,
      title: { before: item.previousTitle, after: item.title },
      normalizedTitle: { before: item.previousNormalizedTitle, after: item.normalizedTitle },
      titlePinyin: { before: item.previousTitlePinyin, after: item.titlePinyin },
      titleInitials: { before: item.previousTitleInitials, after: item.titleInitials },
      primaryArtistName: { before: item.previousPrimaryArtistName, after: item.primaryArtistName },
      artistNames: { before: item.previousArtistNames, after: item.artistNames },
      parseStrategy: { before: item.previousParseStrategy, after: item.parseStrategy }
    })),
    skippedExamples: plan.skipped.slice(0, 20)
  };
}

function hasMetadataChange(item: RepairPlanItem): boolean {
  return item.title !== item.previousTitle
    || item.normalizedTitle !== item.previousNormalizedTitle
    || item.titlePinyin !== item.previousTitlePinyin
    || item.titleInitials !== item.previousTitleInitials
    || item.primaryArtistName !== item.previousPrimaryArtistName
    || item.normalizedPrimaryArtistName !== item.previousNormalizedPrimaryArtistName
    || item.artistNames.join("\u0000") !== item.previousArtistNames.join("\u0000")
    || item.parseStrategy !== item.previousParseStrategy
    || item.parseConfidence !== item.previousParseConfidence;
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

function normalizeRoot(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
}

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function clean(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text || undefined;
}

function usage(): string {
  return `Usage: pnpm -F @home-ktv/api repair:ktv-song-metadata -- [--apply] [--root 合唱歌曲] [--root 综艺精选]

Re-parse filename-derived ktv_songs metadata and update only:
title, normalized_title, title_pinyin, title_initials, primary_artist_name,
normalized_primary_artist_name, artist_names, parse_strategy, parse_confidence.

It does not touch style_tags, technical_status, technical_metadata, cover_image_url, or request_count.
Without --apply this command prints a dry-run summary only.`;
}
