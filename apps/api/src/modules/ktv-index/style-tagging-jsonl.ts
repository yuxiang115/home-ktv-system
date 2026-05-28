import { createReadStream } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type { QueryExecutor } from "../../db/query-executor.js";
import { normalizeSearchText } from "../catalog/search-normalization.js";
import type { KtvStyleTaggingSong } from "./ktv-style-tagging-service.js";
import type { KtvStyleTagEvidence, KtvStyleTaggerResult } from "./netease-style-tagger.js";
import {
  isAllowedKtvStyleTag,
  ktvStyleTagId,
  ktvStyleTaxonomy,
  normalizeKtvStyleTagName
} from "./style-taxonomy.js";

export const NETEASE_STYLE_TAGGING_SOURCE = "netease-playlist-v1";
export const LLM_STYLE_TAGGING_SOURCE = "llm-style-v1";

export interface StyleTaggingJsonlSongInput {
  schemaVersion?: number;
  songKey?: string;
  sourceSongId?: string;
  title: string;
  artistName: string;
  normalizedTitle?: string;
  normalizedArtistName?: string;
  assetPaths?: readonly string[];
}

export interface StyleTaggingJsonlSong extends KtvStyleTaggingSong {
  schemaVersion: 1;
  songKey: string;
  sourceSongId?: string;
  normalizedTitle: string;
  normalizedArtistName: string;
  assetPaths: string[];
}

export interface StyleTaggingJsonlResultRow {
  schemaVersion: 1;
  source: string;
  songKey: string;
  sourceSongId?: string;
  song: {
    title: string;
    artistName: string;
    normalizedTitle: string;
    normalizedArtistName: string;
    assetPaths: string[];
  };
  status: "tagged" | "empty" | "failed";
  tags: KtvStyleTagEvidence[];
  evidence: Record<string, unknown>;
  processedAt: string;
  elapsedMs: number;
  errorMessage?: string;
}

export interface StyleTaggingJsonlTagger {
  tagSong(song: StyleTaggingJsonlSong): Promise<KtvStyleTaggerResult>;
}

export interface RunStyleTaggingJsonlInput {
  inputPath: string;
  outputPath: string;
  source: string;
  tagger: StyleTaggingJsonlTagger;
  limit?: number;
  now?: () => number;
  onProgress?: (event: StyleTaggingJsonlProgressEvent) => void;
}

export interface StyleTaggingJsonlProgressEvent {
  selected: number;
  processed: number;
  skipped: number;
  title: string;
  artistName: string;
  status: "tagged" | "empty" | "failed";
  tagCount: number;
  elapsedMs: number;
  errorMessage: string | null;
}

export interface RunStyleTaggingJsonlResult {
  selected: number;
  processed: number;
  skipped: number;
  tagged: number;
  empty: number;
  failed: number;
  elapsedMs: number;
}

export interface ExportStyleTaggingSongsJsonlInput {
  db: QueryExecutor;
  outPath: string;
  limit?: number;
}

export interface ExportStyleTaggingSongsJsonlResult {
  exported: number;
  outPath: string;
}

export interface ImportStyleTaggingJsonlInput {
  db: QueryExecutor;
  inputPath: string;
  apply: boolean;
}

export interface ImportStyleTaggingJsonlResult {
  total: number;
  imported: number;
  unmatched: number;
  tagged: number;
  empty: number;
  failed: number;
  writtenTags: number;
  dryRun: boolean;
}

interface KtvStyleTaggingExportDbRow {
  id: string;
  title: string;
  primary_artist_name: string;
  normalized_title: string;
  normalized_primary_artist_name: string;
  asset_paths: string[] | null;
}

interface IdRow {
  id: string;
}

export function buildStyleTaggingSongKey(input: {
  title: string;
  artistName: string;
  normalizedTitle?: string | undefined;
  normalizedArtistName?: string | undefined;
  assetPaths?: readonly string[] | undefined;
}): string {
  const title = normalizeIdentityPart(input.normalizedTitle ?? input.title);
  const artist = normalizeIdentityPart(input.normalizedArtistName ?? input.artistName);
  const assetPath = normalizeAssetPath(input.assetPaths?.find((value) => value.trim().length > 0));
  return [title, artist, assetPath].filter((part) => part.length > 0).join("|");
}

export async function exportStyleTaggingSongsJsonl(
  input: ExportStyleTaggingSongsJsonlInput
): Promise<ExportStyleTaggingSongsJsonlResult> {
  const limitClause = input.limit === undefined ? "" : "LIMIT $1";
  const values = input.limit === undefined ? [] : [input.limit];
  const result = await input.db.query<KtvStyleTaggingExportDbRow>(
    `SELECT s.id,
            s.title,
            s.primary_artist_name,
            s.normalized_title,
            s.normalized_primary_artist_name,
            COALESCE(
              array_agg(a.file_path ORDER BY a.file_path) FILTER (WHERE a.file_path IS NOT NULL),
              '{}'
            ) AS asset_paths
     FROM ktv_songs s
     JOIN ktv_song_assets a ON a.song_id = s.id AND a.missing_at IS NULL
     GROUP BY s.id,
              s.title,
              s.primary_artist_name,
              s.normalized_title,
              s.normalized_primary_artist_name,
              s.updated_at
     ORDER BY s.updated_at DESC, s.id ASC
     ${limitClause}`,
    values
  );
  const rows = result.rows.map((row): StyleTaggingJsonlSongInput => {
    const assetPaths = row.asset_paths ?? [];
    return {
      schemaVersion: 1,
      sourceSongId: row.id,
      title: row.title,
      artistName: row.primary_artist_name,
      normalizedTitle: row.normalized_title,
      normalizedArtistName: row.normalized_primary_artist_name,
      assetPaths,
      songKey: buildStyleTaggingSongKey({
        title: row.title,
        artistName: row.primary_artist_name,
        normalizedTitle: row.normalized_title,
        normalizedArtistName: row.normalized_primary_artist_name,
        assetPaths
      })
    };
  });

  await writeJsonl(input.outPath, rows);
  return { exported: rows.length, outPath: input.outPath };
}

export async function runStyleTaggingJsonl(input: RunStyleTaggingJsonlInput): Promise<RunStyleTaggingJsonlResult> {
  const startedAt = now(input);
  const songs = (await readJsonl<StyleTaggingJsonlSongInput>(input.inputPath))
    .map((row) => normalizeSongRow(row))
    .slice(0, input.limit);
  const processedKeys = await readProcessedKeys(input.outputPath, input.source);
  const selected = songs.length;
  let skipped = 0;
  let processed = 0;
  let tagged = 0;
  let empty = 0;
  let failed = 0;

  await mkdir(path.dirname(input.outputPath), { recursive: true });

  for (const song of songs) {
    if (processedKeys.has(song.songKey)) {
      skipped += 1;
      continue;
    }

    const rowStartedAt = now(input);
    try {
      const result = await input.tagger.tagSong(song);
      const tags = sanitizeTags(result.tags);
      const status = tags.length > 0 ? "tagged" : "empty";
      if (status === "tagged") {
        tagged += 1;
      } else {
        empty += 1;
      }
      processed += 1;
      await appendJsonl(input.outputPath, buildResultRow({
        song,
        source: input.source,
        status,
        tags,
        evidence: result.evidence,
        processedAt: new Date(now(input)).toISOString(),
        elapsedMs: now(input) - rowStartedAt
      }));
      processedKeys.add(song.songKey);
      input.onProgress?.({
        selected,
        processed,
        skipped,
        title: song.title,
        artistName: song.artistName,
        status,
        tagCount: tags.length,
        elapsedMs: now(input) - startedAt,
        errorMessage: null
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      failed += 1;
      processed += 1;
      await appendJsonl(input.outputPath, buildResultRow({
        song,
        source: input.source,
        status: "failed",
        tags: [],
        evidence: {},
        processedAt: new Date(now(input)).toISOString(),
        elapsedMs: now(input) - rowStartedAt,
        errorMessage
      }));
      processedKeys.add(song.songKey);
      input.onProgress?.({
        selected,
        processed,
        skipped,
        title: song.title,
        artistName: song.artistName,
        status: "failed",
        tagCount: 0,
        elapsedMs: now(input) - startedAt,
        errorMessage
      });
    }
  }

  return {
    selected,
    processed,
    skipped,
    tagged,
    empty,
    failed,
    elapsedMs: now(input) - startedAt
  };
}

export async function importStyleTaggingJsonlResults(
  input: ImportStyleTaggingJsonlInput
): Promise<ImportStyleTaggingJsonlResult> {
  const rows = await readJsonl<StyleTaggingJsonlResultRow>(input.inputPath);
  let imported = 0;
  let unmatched = 0;
  let tagged = 0;
  let empty = 0;
  let failed = 0;
  let writtenTags = 0;

  if (input.apply) {
    await ensureTaxonomy(input.db);
  }

  for (const row of rows) {
    const songId = await findCurrentSongId(input.db, row);
    if (!songId) {
      unmatched += 1;
      continue;
    }

    const source = row.source;
    const tags = sanitizeTags(row.tags);
    const status = row.status === "failed" ? "failed" : tags.length > 0 ? "tagged" : "empty";

    if (status === "tagged") {
      tagged += 1;
    } else if (status === "empty") {
      empty += 1;
    } else {
      failed += 1;
    }

    if (input.apply) {
      if (status !== "failed") {
        await replaceSongTags(input.db, songId, source, tags);
        writtenTags += tags.length;
      }
      await upsertStatus(input.db, {
        songId,
        source,
        status,
        tagCount: status === "tagged" ? tags.length : 0,
        confidence: status === "tagged" ? average(tags.map((tag) => tag.confidence)) : undefined,
        errorMessage: row.errorMessage
      });
    }

    imported += 1;
  }

  return {
    total: rows.length,
    imported,
    unmatched,
    tagged,
    empty,
    failed,
    writtenTags,
    dryRun: !input.apply
  };
}

async function findCurrentSongId(db: QueryExecutor, row: StyleTaggingJsonlResultRow): Promise<string | null> {
  if (row.sourceSongId) {
    const byId = await db.query<IdRow>(
      `SELECT id
       FROM ktv_songs
       WHERE id = $1
       LIMIT 1`,
      [row.sourceSongId]
    );
    const id = byId.rows[0]?.id;
    if (id) {
      return id;
    }
  }

  const normalizedTitle = normalizeIdentityPart(row.song.normalizedTitle || row.song.title);
  const normalizedArtistName = normalizeIdentityPart(row.song.normalizedArtistName || row.song.artistName);
  const byIdentity = await db.query<IdRow>(
    `SELECT s.id
     FROM ktv_songs s
     WHERE s.normalized_title = $1
       AND s.normalized_primary_artist_name = $2
     ORDER BY s.updated_at DESC, s.id ASC
     LIMIT 1`,
    [normalizedTitle, normalizedArtistName]
  );
  return byIdentity.rows[0]?.id ?? null;
}

async function ensureTaxonomy(db: QueryExecutor): Promise<void> {
  for (const group of ktvStyleTaxonomy) {
    await db.query(
      `INSERT INTO ktv_style_groups (id, name, sort_order)
       VALUES ($1, $2, $3)
       ON CONFLICT (name)
       DO UPDATE SET sort_order = EXCLUDED.sort_order,
                     enabled = true,
                     updated_at = now()`,
      [group.id, group.name, group.sortOrder]
    );
    for (let index = 0; index < group.tags.length; index += 1) {
      const tag = group.tags[index]!;
      await db.query(
        `INSERT INTO ktv_style_tags (group_id, id, name, normalized_name, sort_order)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (normalized_name)
         DO UPDATE SET group_id = EXCLUDED.group_id,
                       name = EXCLUDED.name,
                       sort_order = EXCLUDED.sort_order,
                       enabled = true,
                       updated_at = now()`,
        [group.id, ktvStyleTagId(tag), tag, normalizeKtvStyleTagName(tag), index + 1]
      );
    }
  }
}

async function replaceSongTags(
  db: QueryExecutor,
  songId: string,
  source: string,
  tags: readonly KtvStyleTagEvidence[]
): Promise<void> {
  await db.query(
    `DELETE FROM ktv_song_style_tags
     WHERE song_id = $1
       AND source = $2
       AND locked = false`,
    [songId, source]
  );

  for (const tag of tags) {
    await db.query(
      `INSERT INTO ktv_song_style_tags (song_id, tag_id, source, confidence, evidence)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (song_id, tag_id, source)
       DO UPDATE SET confidence = EXCLUDED.confidence,
                     evidence = EXCLUDED.evidence,
                     updated_at = now()`,
      [
        songId,
        ktvStyleTagId(tag.tag),
        source,
        clampConfidence(tag.confidence),
        JSON.stringify({ tag: tag.tag, evidence: tag.evidence })
      ]
    );
  }
}

async function upsertStatus(
  db: QueryExecutor,
  input: {
    songId: string;
    source: string;
    status: "tagged" | "empty" | "failed";
    tagCount: number;
    confidence?: number | undefined;
    errorMessage?: string | undefined;
  }
): Promise<void> {
  await db.query(
    `INSERT INTO ktv_song_tagging_status (
       song_id, source, status, tag_count, confidence, run_id, error_message
     )
     VALUES ($1, $2, $3, $4, $5, NULL, $6)
     ON CONFLICT (song_id, source)
     DO UPDATE SET status = EXCLUDED.status,
                   tag_count = EXCLUDED.tag_count,
                   confidence = EXCLUDED.confidence,
                   run_id = EXCLUDED.run_id,
                   error_message = EXCLUDED.error_message,
                   updated_at = now()`,
    [
      input.songId,
      input.source,
      input.status,
      input.tagCount,
      input.confidence ?? null,
      input.errorMessage ?? null
    ]
  );
}

function normalizeSongRow(row: StyleTaggingJsonlSongInput): StyleTaggingJsonlSong {
  const title = requireText(row.title, "title");
  const artistName = requireText(row.artistName, "artistName");
  const normalizedTitle = normalizeIdentityPart(row.normalizedTitle ?? title);
  const normalizedArtistName = normalizeIdentityPart(row.normalizedArtistName ?? artistName);
  const assetPaths = Array.isArray(row.assetPaths)
    ? row.assetPaths.map((assetPath) => assetPath.trim()).filter(Boolean)
    : [];
  const sourceSongId = typeof row.sourceSongId === "string" && row.sourceSongId.trim()
    ? row.sourceSongId.trim()
    : undefined;
  const songKey = typeof row.songKey === "string" && row.songKey.trim()
    ? row.songKey.trim()
    : buildStyleTaggingSongKey({ title, artistName, normalizedTitle, normalizedArtistName, assetPaths });

  const song: StyleTaggingJsonlSong = {
    schemaVersion: 1,
    id: sourceSongId ?? songKey,
    songKey,
    title,
    artistName,
    normalizedTitle,
    normalizedArtistName,
    assetPaths
  };
  if (sourceSongId) {
    song.sourceSongId = sourceSongId;
  }
  return song;
}

function buildResultRow(input: {
  song: StyleTaggingJsonlSong;
  source: string;
  status: "tagged" | "empty" | "failed";
  tags: KtvStyleTagEvidence[];
  evidence: Record<string, unknown>;
  processedAt: string;
  elapsedMs: number;
  errorMessage?: string | undefined;
}): StyleTaggingJsonlResultRow {
  const row: StyleTaggingJsonlResultRow = {
    schemaVersion: 1,
    source: input.source,
    songKey: input.song.songKey,
    song: {
      title: input.song.title,
      artistName: input.song.artistName,
      normalizedTitle: input.song.normalizedTitle,
      normalizedArtistName: input.song.normalizedArtistName,
      assetPaths: input.song.assetPaths
    },
    status: input.status,
    tags: input.tags,
    evidence: input.evidence,
    processedAt: input.processedAt,
    elapsedMs: input.elapsedMs
  };
  if (input.song.sourceSongId) {
    row.sourceSongId = input.song.sourceSongId;
  }
  if (input.errorMessage) {
    row.errorMessage = input.errorMessage;
  }
  return row;
}

function sanitizeTags(tags: readonly KtvStyleTagEvidence[]): KtvStyleTagEvidence[] {
  const seen = new Set<string>();
  const sanitized: KtvStyleTagEvidence[] = [];
  for (const tag of tags) {
    if (!isAllowedKtvStyleTag(tag.tag) || seen.has(tag.tag)) {
      continue;
    }
    seen.add(tag.tag);
    sanitized.push({
      tag: tag.tag,
      confidence: clampConfidence(tag.confidence),
      evidence: Array.isArray(tag.evidence) ? tag.evidence.map(String).slice(0, 10) : []
    });
  }
  return sanitized;
}

async function readProcessedKeys(outputPath: string, source: string): Promise<Set<string>> {
  const rows = await readJsonlIfExists<StyleTaggingJsonlResultRow>(outputPath);
  const keys = new Set<string>();
  for (const row of rows) {
    if (row.source === source && typeof row.songKey === "string" && row.songKey.length > 0) {
      keys.add(row.songKey);
    }
  }
  return keys;
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  const rows: T[] = [];
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      rows.push(JSON.parse(trimmed) as T);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid JSONL at ${filePath}:${lineNumber}: ${message}`);
    }
  }
  return rows;
}

async function readJsonlIfExists<T>(filePath: string): Promise<T[]> {
  try {
    await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return readJsonl<T>(filePath);
}

async function writeJsonl(filePath: string, rows: readonly unknown[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const text = rows.map((row) => JSON.stringify(row)).join("\n");
  await writeFile(filePath, text.length > 0 ? `${text}\n` : "", "utf8");
}

async function appendJsonl(filePath: string, row: unknown): Promise<void> {
  await appendFile(filePath, `${JSON.stringify(row)}\n`, "utf8");
}

function normalizeIdentityPart(value: string): string {
  return normalizeSearchText(value);
}

function normalizeAssetPath(value: string | undefined): string {
  return value?.trim().normalize("NFKC").toLocaleLowerCase() ?? "";
}

function requireText(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`JSONL song row is missing ${fieldName}`);
  }
  return trimmed;
}

function now(input: { now?: () => number }): number {
  return input.now?.() ?? Date.now();
}

function average(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 1000) / 1000;
}

function clampConfidence(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
