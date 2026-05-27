import path from "node:path";
import type { QueryExecutor } from "../../db/query-executor.js";
import { buildPinyinSearchKeys, normalizeSearchText } from "../catalog/search-normalization.js";
import {
  buildKtvSampleRow,
  type KtvSampleParseStrategy,
  type KtvSampleSourceFile
} from "./ktv-sample-index.js";

export interface KtvIndexAssetDraft {
  title: string;
  normalizedTitle: string;
  titlePinyin: string;
  titleInitials: string;
  artistNames: string[];
  category: string;
  filePath: string;
  relativePath: string;
  fileName: string;
  extension: string;
  sizeBytes: number | null;
  mtimeMs: number | null;
  parseStrategy: KtvSampleParseStrategy;
  parseConfidence: number;
  technicalStatus: "pending" | "probed" | "failed";
  technicalMetadata: Record<string, unknown>;
}

export interface IndexKtvAssetDraftsInput {
  sourceRoot: string;
  sshHost?: string | undefined;
  drafts: readonly KtvIndexAssetDraft[];
  batchSize?: number;
  markMissingAssets?: boolean;
}

export interface IndexKtvAssetDraftsResult {
  runId: string;
  filesSeen: number;
  songsUpserted: number;
  assetsUpserted: number;
  assetsMarkedMissing: number;
}

interface IdRow {
  id: string;
}

export function buildKtvIndexAssetDraft(sourceFile: KtvSampleSourceFile): KtvIndexAssetDraft {
  const sample = buildKtvSampleRow(sourceFile);
  const titleKeys = buildPinyinSearchKeys(sample.title);
  const artistNames = splitArtistNames(sample.artistName);

  return {
    title: sample.title,
    normalizedTitle: normalizeSearchText(sample.title),
    titlePinyin: titleKeys.pinyin,
    titleInitials: titleKeys.initials,
    artistNames,
    category: sample.category ?? "未分类",
    filePath: sample.sourcePath,
    relativePath: sample.relativePath,
    fileName: sample.fileName,
    extension: sample.extension || path.extname(sample.fileName).toLocaleLowerCase(),
    sizeBytes: sample.sizeBytes,
    mtimeMs: sample.mtimeMs,
    parseStrategy: sample.parseStrategy,
    parseConfidence: sample.parseConfidence,
    technicalStatus: "pending",
    technicalMetadata: {}
  };
}

export async function indexKtvAssetDrafts(
  db: QueryExecutor,
  input: IndexKtvAssetDraftsInput
): Promise<IndexKtvAssetDraftsResult> {
  const runId = await startRun(db, input);
  let songsUpserted = 0;
  let assetsUpserted = 0;
  let assetsMarkedMissing = 0;

  try {
    for (const draft of input.drafts) {
      const primaryArtistName = draft.artistNames[0] ?? "Unknown Artist";
      const artistRows = [];
      for (const artistName of draft.artistNames) {
        artistRows.push(await upsertArtist(db, artistName));
      }

      const songId = await upsertSong(db, draft, primaryArtistName);
      songsUpserted += 1;
      for (let index = 0; index < artistRows.length; index += 1) {
        await upsertSongArtist(db, songId, artistRows[index]?.id ?? "", index);
      }
      await upsertAsset(db, draft, songId, runId);
      assetsUpserted += 1;
    }

    if (input.markMissingAssets) {
      assetsMarkedMissing = await markMissingAssets(db, runId);
    }

    await finishRun(db, {
      runId,
      status: "completed",
      filesSeen: input.drafts.length,
      songsUpserted,
      assetsUpserted
    });
    return {
      runId,
      filesSeen: input.drafts.length,
      songsUpserted,
      assetsUpserted,
      assetsMarkedMissing
    };
  } catch (error) {
    await finishRun(db, {
      runId,
      status: "failed",
      filesSeen: input.drafts.length,
      songsUpserted,
      assetsUpserted,
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

function splitArtistNames(value: string): string[] {
  const parts = value
    .split(/(?:_|&|、|，|,|\/|\s{2,})/u)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length ? parts : [value.trim() || "Unknown Artist"];
}

async function startRun(db: QueryExecutor, input: IndexKtvAssetDraftsInput): Promise<string> {
  const result = await db.query<IdRow>(
    `INSERT INTO ktv_index_runs (source_root, ssh_host, status, files_seen)
     VALUES ($1, $2, 'running', $3)
     RETURNING id`,
    [input.sourceRoot, input.sshHost ?? null, input.drafts.length]
  );
  return requireRow(result.rows[0], "ktv_index_runs insert").id;
}

async function upsertArtist(db: QueryExecutor, name: string): Promise<IdRow> {
  const normalizedName = normalizeSearchText(name);
  const pinyinKeys = buildPinyinSearchKeys(name);
  const result = await db.query<IdRow>(
    `INSERT INTO ktv_artists (name, normalized_name, name_pinyin, name_initials)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (normalized_name)
     DO UPDATE SET
       name = EXCLUDED.name,
       name_pinyin = EXCLUDED.name_pinyin,
       name_initials = EXCLUDED.name_initials,
       updated_at = now()
     RETURNING id`,
    [name, normalizedName, pinyinKeys.pinyin, pinyinKeys.initials]
  );
  return requireRow(result.rows[0], "ktv_artists upsert");
}

async function upsertSong(db: QueryExecutor, draft: KtvIndexAssetDraft, primaryArtistName: string): Promise<string> {
  const normalizedPrimaryArtistName = normalizeSearchText(primaryArtistName);
  const result = await db.query<IdRow>(
    `INSERT INTO ktv_songs (
       title, normalized_title, title_pinyin, title_initials,
       primary_artist_name, normalized_primary_artist_name, category
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (normalized_title, normalized_primary_artist_name, category)
     DO UPDATE SET
       title = EXCLUDED.title,
       title_pinyin = EXCLUDED.title_pinyin,
       title_initials = EXCLUDED.title_initials,
       primary_artist_name = EXCLUDED.primary_artist_name,
       updated_at = now()
     RETURNING id`,
    [
      draft.title,
      draft.normalizedTitle,
      draft.titlePinyin,
      draft.titleInitials,
      primaryArtistName,
      normalizedPrimaryArtistName,
      draft.category
    ]
  );
  return requireRow(result.rows[0], "ktv_songs upsert").id;
}

async function upsertSongArtist(db: QueryExecutor, songId: string, artistId: string, artistOrder: number): Promise<void> {
  if (!artistId) {
    return;
  }
  await db.query(
    `INSERT INTO ktv_song_artists (song_id, artist_id, artist_order)
     VALUES ($1, $2, $3)
     ON CONFLICT (song_id, artist_id)
     DO UPDATE SET artist_order = EXCLUDED.artist_order`,
    [songId, artistId, artistOrder]
  );
}

async function upsertAsset(db: QueryExecutor, draft: KtvIndexAssetDraft, songId: string, runId: string): Promise<string> {
  const result = await db.query<IdRow>(
    `INSERT INTO ktv_song_assets (
       song_id, file_path, relative_path, file_name, extension, size_bytes, mtime_ms,
       parse_strategy, parse_confidence, technical_status, technical_metadata,
       first_seen_run_id, last_seen_run_id, missing_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $12, NULL)
     ON CONFLICT (file_path)
     DO UPDATE SET
       song_id = EXCLUDED.song_id,
       relative_path = EXCLUDED.relative_path,
       file_name = EXCLUDED.file_name,
       extension = EXCLUDED.extension,
       size_bytes = EXCLUDED.size_bytes,
       mtime_ms = EXCLUDED.mtime_ms,
       parse_strategy = EXCLUDED.parse_strategy,
       parse_confidence = EXCLUDED.parse_confidence,
       last_seen_run_id = EXCLUDED.last_seen_run_id,
       missing_at = NULL,
       updated_at = now()
     RETURNING id`,
    [
      songId,
      draft.filePath,
      draft.relativePath,
      draft.fileName,
      draft.extension,
      draft.sizeBytes,
      draft.mtimeMs,
      draft.parseStrategy,
      draft.parseConfidence,
      draft.technicalStatus,
      JSON.stringify(draft.technicalMetadata),
      runId
    ]
  );
  return requireRow(result.rows[0], "ktv_song_assets upsert").id;
}

async function markMissingAssets(db: QueryExecutor, runId: string): Promise<number> {
  const result = await db.query<{ count: number | string }>(
    `WITH marked AS (
       UPDATE ktv_song_assets
       SET missing_at = now(),
           updated_at = now()
       WHERE last_seen_run_id IS DISTINCT FROM $1
         AND missing_at IS NULL
       RETURNING 1
     )
     SELECT count(*)::int AS count FROM marked`,
    [runId]
  );
  const row = requireRow(result.rows[0], "ktv_song_assets missing marker");
  return typeof row.count === "number" ? row.count : Number.parseInt(row.count, 10);
}

async function finishRun(
  db: QueryExecutor,
  input: {
    runId: string;
    status: "completed" | "failed";
    filesSeen: number;
    songsUpserted: number;
    assetsUpserted: number;
    errorMessage?: string | undefined;
  }
): Promise<void> {
  await db.query(
    `UPDATE ktv_index_runs
     SET status = $2,
         files_seen = $3,
         songs_upserted = $4,
         assets_upserted = $5,
         error_message = $6,
         finished_at = now(),
         updated_at = now()
     WHERE id = $1`,
    [
      input.runId,
      input.status,
      input.filesSeen,
      input.songsUpserted,
      input.assetsUpserted,
      input.errorMessage ?? null
    ]
  );
}

function requireRow<TRow>(row: TRow | undefined, context: string): TRow {
  if (!row) {
    throw new Error(`${context} did not return a row`);
  }
  return row;
}
