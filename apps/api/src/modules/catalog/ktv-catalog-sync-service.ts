import type {
  AssetId,
  CompatibilityReason,
  MediaInfoProvenance,
  MediaInfoSummary,
  PlaybackProfile,
  SongId,
  TrackRoles
} from "@home-ktv/domain";
import type { QueryExecutor } from "../../db/query-executor.js";
import { buildNasSample } from "../ktv-index/ktv-index-diagnostics.js";
import { buildPinyinSearchKeys, normalizeSearchText } from "./search-normalization.js";

export interface KtvCatalogSyncResult {
  songId: SongId;
  assetId: AssetId;
  indexedSongId: string;
  indexedAssetId: string;
  sourceRecordId: string;
  status: "created" | "reused" | "updated";
}

export type KtvCatalogSyncErrorCode =
  | "KTV_INDEX_ASSET_STALE"
  | "KTV_INDEX_FILE_UNREADABLE"
  | "KTV_INDEX_SYNC_FAILED";

export class KtvCatalogSyncError extends Error {
  constructor(
    readonly code: KtvCatalogSyncErrorCode,
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
  }
}

export interface PgKtvCatalogSyncServiceOptions {
  checkFileAccess?: boolean;
  sampleTimeoutMs?: number;
  accessFile?: (filePath: string) => Promise<void>;
}

interface KtvIndexedAssetSyncRow {
  id: string;
  song_id: string;
  file_path: string;
  relative_path: string;
  file_name: string;
  extension: string;
  size_bytes: number | string | null;
  parse_confidence: number | string;
  missing_at: Date | string | null;
  title: string;
  primary_artist_name: string;
  category: string;
  source_root: string | null;
}

interface ExistingSourceRecordRow {
  id: string;
  asset_id: string;
}

export class PgKtvCatalogSyncService {
  constructor(
    private readonly db: QueryExecutor,
    private readonly options: PgKtvCatalogSyncServiceOptions = {}
  ) {}

  async syncIndexedAsset(input: { indexedAssetId: string }): Promise<KtvCatalogSyncResult> {
    const existingSource = await this.findExistingSourceRecord(input.indexedAssetId);
    const row = await this.getIndexedAsset(input.indexedAssetId);
    if (!row || row.missing_at !== null) {
      throw new KtvCatalogSyncError("KTV_INDEX_ASSET_STALE", "索引已失效");
    }

    await this.assertReadable(row);

    const indexedSongId = row.song_id;
    const indexedAssetId = row.id;
    const songId = `song-ktv-${indexedSongId}` as SongId;
    const assetId = `asset-ktv-${indexedAssetId}` as AssetId;
    const sourceRecordId = `source-ktv-index-asset-${indexedAssetId}`;

    try {
      await this.upsertSong({ row, songId });
      await this.upsertAsset({ row, songId, assetId });
      await this.upsertSourceRecord({ row, assetId, sourceRecordId });
      await this.updateDefaultAsset(songId, assetId);
    } catch (error) {
      if (error instanceof KtvCatalogSyncError) {
        throw error;
      }
      throw new KtvCatalogSyncError("KTV_INDEX_SYNC_FAILED", "KTV 索引同步失败", error);
    }

    return {
      songId,
      assetId,
      indexedSongId,
      indexedAssetId,
      sourceRecordId,
      status: existingSource ? "updated" : "created"
    };
  }

  private async findExistingSourceRecord(indexedAssetId: string): Promise<ExistingSourceRecordRow | null> {
    const result = await this.db.query<ExistingSourceRecordRow>(
      `SELECT id, asset_id
       FROM source_records
       WHERE provider = 'ktv-index'
         AND provider_item_id = $1
       LIMIT 1`,
      [indexedAssetId]
    );
    return result.rows[0] ?? null;
  }

  private async getIndexedAsset(indexedAssetId: string): Promise<KtvIndexedAssetSyncRow | null> {
    const result = await this.db.query<KtvIndexedAssetSyncRow>(
      `SELECT a.id,
              a.song_id,
              a.file_path,
              a.relative_path,
              a.file_name,
              a.extension,
              a.size_bytes,
              a.parse_confidence,
              a.missing_at,
              s.title,
              s.primary_artist_name,
              s.category,
              r.source_root
       FROM ktv_song_assets a
       JOIN ktv_songs s ON s.id = a.song_id
       LEFT JOIN ktv_index_runs r ON r.id = a.last_seen_run_id
       WHERE a.id = $1
       LIMIT 1`,
      [indexedAssetId]
    );
    return result.rows[0] ?? null;
  }

  private async assertReadable(row: KtvIndexedAssetSyncRow): Promise<void> {
    if (this.options.checkFileAccess === false) {
      return;
    }

    const sample = await buildNasSample({
      assets: [{ indexedAssetId: row.id, filePath: row.file_path }],
      sourceRoot: row.source_root,
      timeoutMs: this.options.sampleTimeoutMs ?? 250,
      ...(this.options.accessFile ? { accessFile: this.options.accessFile } : {})
    });
    const result = sample.results[0];
    if (!result?.readable) {
      throw new KtvCatalogSyncError("KTV_INDEX_FILE_UNREADABLE", "文件不可读");
    }
  }

  private async upsertSong(input: { row: KtvIndexedAssetSyncRow; songId: SongId }): Promise<void> {
    const titleKeys = buildPinyinSearchKeys(input.row.title);
    const artistKeys = buildPinyinSearchKeys(input.row.primary_artist_name);
    const artistId = `artist-ktv-${normalizeSearchText(input.row.primary_artist_name) || "unknown"}`;
    const genre = compact([input.row.category]);
    const searchHints = compact([input.row.category, input.row.extension, input.row.primary_artist_name]);

    await this.db.query(
      `INSERT INTO songs (
         id, title, normalized_title, title_pinyin, title_initials,
         artist_id, artist_name, artist_pinyin, artist_initials,
         language, status, genre, tags, aliases, search_hints,
         release_year, canonical_duration_ms, default_asset_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'mandarin', 'ready', $10, ARRAY['ktv-index'], '{}', $11, NULL, 0, NULL)
       ON CONFLICT(id)
       DO UPDATE SET title = EXCLUDED.title,
                     normalized_title = EXCLUDED.normalized_title,
                     title_pinyin = EXCLUDED.title_pinyin,
                     title_initials = EXCLUDED.title_initials,
                     artist_id = EXCLUDED.artist_id,
                     artist_name = EXCLUDED.artist_name,
                     artist_pinyin = EXCLUDED.artist_pinyin,
                     artist_initials = EXCLUDED.artist_initials,
                     language = EXCLUDED.language,
                     status = EXCLUDED.status,
                     genre = EXCLUDED.genre,
                     tags = EXCLUDED.tags,
                     search_hints = EXCLUDED.search_hints,
                     canonical_duration_ms = EXCLUDED.canonical_duration_ms,
                     updated_at = now()`,
      [
        input.songId,
        input.row.title,
        normalizeSearchText(input.row.title),
        titleKeys.pinyin,
        titleKeys.initials,
        artistId,
        input.row.primary_artist_name,
        artistKeys.pinyin,
        artistKeys.initials,
        genre,
        searchHints
      ]
    );
  }

  private async upsertAsset(input: { row: KtvIndexedAssetSyncRow; songId: SongId; assetId: AssetId }): Promise<void> {
    const fileSizeBytes = toNumber(input.row.size_bytes ?? 0);
    const container = normalizeExtension(input.row.extension);
    const compatibilityReasons: CompatibilityReason[] = [
      {
        code: "ktv-index-playback-unverified",
        severity: "warning",
        message: "KTV indexed asset has not completed playback verification",
        source: "scanner"
      }
    ];
    const mediaInfoSummary: MediaInfoSummary = {
      container,
      durationMs: null,
      videoCodec: null,
      resolution: null,
      fileSizeBytes,
      audioTracks: []
    };
    const mediaInfoProvenance: MediaInfoProvenance = {
      source: "unknown",
      sourceVersion: null,
      probedAt: null,
      importedFrom: "ktv-index"
    };
    const trackRoles: TrackRoles = { original: null, instrumental: null };
    const playbackProfile: PlaybackProfile = {
      kind: "single_file_audio_tracks",
      container,
      videoCodec: null,
      audioCodecs: [],
      requiresAudioTrackSelection: false
    };

    await this.db.query(
      `INSERT INTO assets (
         id, song_id, source_type, asset_kind, display_name, file_path, duration_ms,
         lyric_mode, vocal_mode, status, switch_family, switch_quality_status,
         compatibility_status, compatibility_reasons, media_info_summary,
         media_info_provenance, track_roles, playback_profile
       )
       VALUES ($1, $2, 'local', 'dual-track-video', $3, $4, 0, 'none', 'dual', 'ready', NULL,
               'review_required', 'unknown', $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb)
       ON CONFLICT(id)
       DO UPDATE SET song_id = EXCLUDED.song_id,
                     source_type = EXCLUDED.source_type,
                     asset_kind = EXCLUDED.asset_kind,
                     display_name = EXCLUDED.display_name,
                     file_path = EXCLUDED.file_path,
                     duration_ms = EXCLUDED.duration_ms,
                     lyric_mode = EXCLUDED.lyric_mode,
                     vocal_mode = EXCLUDED.vocal_mode,
                     status = EXCLUDED.status,
                     switch_family = EXCLUDED.switch_family,
                     switch_quality_status = EXCLUDED.switch_quality_status,
                     compatibility_status = EXCLUDED.compatibility_status,
                     compatibility_reasons = EXCLUDED.compatibility_reasons,
                     media_info_summary = EXCLUDED.media_info_summary,
                     media_info_provenance = EXCLUDED.media_info_provenance,
                     track_roles = EXCLUDED.track_roles,
                     playback_profile = EXCLUDED.playback_profile,
                     updated_at = now()`,
      [
        input.assetId,
        input.songId,
        input.row.file_name,
        input.row.file_path,
        compatibilityReasons,
        mediaInfoSummary,
        mediaInfoProvenance,
        trackRoles,
        playbackProfile
      ]
    );
  }

  private async upsertSourceRecord(input: {
    row: KtvIndexedAssetSyncRow;
    assetId: AssetId;
    sourceRecordId: string;
  }): Promise<void> {
    const rawMeta = {
      indexedSongId: input.row.song_id,
      indexedAssetId: input.row.id,
      filePath: input.row.file_path,
      relativePath: input.row.relative_path,
      title: input.row.title,
      primaryArtistName: input.row.primary_artist_name,
      category: input.row.category,
      extension: input.row.extension,
      sizeBytes: input.row.size_bytes == null ? null : toNumber(input.row.size_bytes),
      parseConfidence: toNumber(input.row.parse_confidence)
    };

    await this.db.query(
      `INSERT INTO source_records (id, asset_id, provider, provider_item_id, source_uri, raw_meta)
       VALUES ($1, $2, 'ktv-index', $3, $4, $5::jsonb)
       ON CONFLICT(id)
       DO UPDATE SET asset_id = EXCLUDED.asset_id,
                     provider = EXCLUDED.provider,
                     provider_item_id = EXCLUDED.provider_item_id,
                     source_uri = EXCLUDED.source_uri,
                     raw_meta = EXCLUDED.raw_meta,
                     updated_at = now()`,
      [input.sourceRecordId, input.assetId, input.row.id, input.row.file_path, rawMeta]
    );
  }

  private async updateDefaultAsset(songId: SongId, assetId: AssetId): Promise<void> {
    await this.db.query(
      `UPDATE songs
       SET default_asset_id = $2,
           updated_at = now()
       WHERE id = $1`,
      [songId, assetId]
    );
  }
}

function normalizeExtension(extension: string): string | null {
  const value = extension.replace(/^\./u, "").trim().toLowerCase();
  return value.length > 0 ? value : null;
}

function toNumber(value: number | string): number {
  return typeof value === "number" ? value : Number.parseFloat(value);
}

function compact(values: readonly string[]): string[] {
  return values.map((value) => value.trim()).filter((value) => value.length > 0);
}
