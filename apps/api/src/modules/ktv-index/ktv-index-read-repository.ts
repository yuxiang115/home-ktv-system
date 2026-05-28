import type {
  KtvIndexDiagnosticsPreviewResult,
  KtvIndexDiagnosticsResponse,
  KtvIndexNasSampleResult,
  KtvIndexRunSummary,
  KtvIndexTableAvailability,
  SongSearchIndexedResult,
  SongSearchIndexedVersionOption,
  SongSearchMatchReason
} from "@home-ktv/domain";
import type { QueryExecutor } from "../../db/query-executor.js";
import type { MediaPathMapping } from "../assets/media-path-mapping.js";
import { normalizeSearchText } from "../catalog/search-normalization.js";
import { buildNasSample } from "./ktv-index-diagnostics.js";

export interface SearchKtvIndexedSongsInput {
  query: string;
  limit?: number;
  shuffle?: boolean;
  versionsPerSong?: number;
  queuedIndexedAssetIds?: readonly string[];
  unreadableIndexedAssetIds?: readonly string[];
}

export interface GetKtvIndexDiagnosticsInput {
  previewQuery?: string;
  previewLimit?: number;
  sampleSize?: number;
  sampleTimeoutMs?: number;
  deterministicSample?: boolean;
}

export interface KtvIndexReadRepository {
  searchIndexedSongs(input: SearchKtvIndexedSongsInput): Promise<SongSearchIndexedResult[]>;
  getDiagnostics(input?: GetKtvIndexDiagnosticsInput): Promise<KtvIndexDiagnosticsResponse>;
}

export interface KtvIndexReadRepositoryOptions {
  pathMappings?: readonly MediaPathMapping[];
}

type KtvTableName = KtvIndexTableAvailability["tableName"];

const ktvTableNames = [
  "ktv_index_runs",
  "ktv_artists",
  "ktv_songs",
  "ktv_song_artists",
  "ktv_song_assets"
] as const satisfies readonly KtvTableName[];

interface IndexedSearchRow {
  song_id: string;
  title: string;
  primary_artist_name: string;
  style_tags: string[] | null;
  match_reason: SongSearchMatchReason | "style";
  score: number | string;
  asset_id: string;
  file_name: string;
  file_path: string;
  extension: string;
  size_bytes: number | string | null;
  parse_confidence: number | string;
  technical_metadata: unknown;
  missing_at: Date | string | null;
}

interface LatestRunRow {
  id: string;
  source_root: string;
  ssh_host: string | null;
  status: KtvIndexRunSummary["status"];
  files_seen: number | string;
  songs_upserted: number | string;
  assets_upserted: number | string;
  error_message: string | null;
  started_at: Date | string;
  finished_at: Date | string | null;
}

interface CountRow {
  active_asset_count: number | string;
  missing_asset_count: number | string;
  song_count: number | string;
  artist_count: number | string;
}

interface ParseStrategyRow {
  parse_strategy: string;
  count: number | string;
}

interface ConfidenceRow {
  low_confidence_count: number | string;
  min_parse_confidence: number | string | null;
}

interface TechnicalStatusRow {
  technical_status: string | null;
  count: number | string;
}

interface AudioTrackDistributionRow {
  audio_track_count: number | string;
  count: number | string;
}

interface SampleAssetRow {
  id: string;
  file_path: string;
}

export class PgKtvIndexReadRepository implements KtvIndexReadRepository {
  constructor(
    private readonly db: QueryExecutor,
    private readonly options: KtvIndexReadRepositoryOptions = {}
  ) {}

  async searchIndexedSongs(input: SearchKtvIndexedSongsInput): Promise<SongSearchIndexedResult[]> {
    const rows = await this.queryIndexedRows(input);
    return mapIndexedSearchRows(rows, {
      queuedIndexedAssetIds: input.queuedIndexedAssetIds ?? [],
      unreadableIndexedAssetIds: input.unreadableIndexedAssetIds ?? []
    });
  }

  async getDiagnostics(input: GetKtvIndexDiagnosticsInput = {}): Promise<KtvIndexDiagnosticsResponse> {
    const tables = await this.getTableAvailability();
    const emptyNasSample = createEmptyNasSample();

    if (!tables.every((table) => table.exists)) {
      return {
        tables,
        latestRun: null,
        sourceRoot: null,
        activeAssetCount: 0,
        missingAssetCount: 0,
        songCount: 0,
        artistCount: 0,
        parseStrategies: [],
        technicalStatusCounts: [],
        audioTrackDistribution: [],
        probePendingCount: 0,
        probeFailedCount: 0,
        probeCoveragePercent: 0,
        lowConfidenceCount: 0,
        minParseConfidence: null,
        nasSample: emptyNasSample,
        preview: []
      };
    }

    const [latestRun, counts, parseStrategies, technicalStatusCounts, audioTrackDistribution, confidence, preview] =
      await Promise.all([
        this.getLatestRun(),
        this.getCounts(),
        this.getParseStrategies(),
        this.getTechnicalStatusCounts(),
        this.getAudioTrackDistribution(),
        this.getConfidenceSummary(),
        this.searchDiagnosticsPreview({
          query: input.previewQuery ?? "",
          limit: input.previewLimit ?? 8,
          versionsPerSong: 4
        })
      ]);
    const sampleAssets = await this.getSampleAssets(input);
    const nasSample = await buildNasSample({
      assets: sampleAssets.map((asset) => ({ indexedAssetId: asset.id, filePath: asset.file_path })),
      sourceRoot: latestRun?.sourceRoot ?? null,
      ...(this.options.pathMappings ? { pathMappings: this.options.pathMappings } : {}),
      ...(input.sampleTimeoutMs === undefined ? {} : { timeoutMs: input.sampleTimeoutMs })
    });

    return {
      tables,
      latestRun,
      sourceRoot: latestRun?.sourceRoot ?? null,
      activeAssetCount: counts.activeAssetCount,
      missingAssetCount: counts.missingAssetCount,
      songCount: counts.songCount,
      artistCount: counts.artistCount,
      parseStrategies,
      technicalStatusCounts,
      audioTrackDistribution,
      probePendingCount: countTechnicalStatus(technicalStatusCounts, "pending"),
      probeFailedCount: countTechnicalStatus(technicalStatusCounts, "failed"),
      probeCoveragePercent: calculateProbeCoveragePercent({
        activeAssetCount: counts.activeAssetCount,
        probedCount: countTechnicalStatus(technicalStatusCounts, "probed")
      }),
      lowConfidenceCount: confidence.lowConfidenceCount,
      minParseConfidence: confidence.minParseConfidence,
      nasSample,
      preview
    };
  }

  private async queryIndexedRows(input: SearchKtvIndexedSongsInput): Promise<IndexedSearchRow[]> {
    const normalizedQuery = normalizeSearchText(input.query);
    const likeQuery = `%${normalizedQuery}%`;
    const tagQuery = `%${input.query.trim()}%`;
    const limit = Math.min(500, Math.max(1, input.limit ?? 20));
    const versionsPerSong = Math.min(8, Math.max(1, input.versionsPerSong ?? 4));
    const matchedSongOrder = input.shuffle
      ? "random(), score DESC, s.title ASC, s.primary_artist_name ASC"
      : "score DESC, s.title ASC, s.primary_artist_name ASC";

    const result = await this.db.query<IndexedSearchRow>(
      `WITH matched_songs AS (
         SELECT s.id AS song_id,
                s.title,
                s.primary_artist_name,
                COALESCE((
                  SELECT array_agg(tag_name ORDER BY group_sort, tag_sort, tag_name)
                  FROM (
                    SELECT DISTINCT t.name AS tag_name,
                           g.sort_order AS group_sort,
                           t.sort_order AS tag_sort
                    FROM ktv_song_style_tags st
                    JOIN ktv_style_tags t ON t.id = st.tag_id AND t.enabled = true
                    JOIN ktv_style_groups g ON g.id = t.group_id AND g.enabled = true
                    WHERE st.song_id = s.id
                  ) style_tag_rows
                ), ARRAY[]::text[]) AS style_tags,
                CASE
                  WHEN $1 = '' THEN 1
                  WHEN s.normalized_title = $1 THEN 100
                  WHEN s.normalized_primary_artist_name = $1 THEN 90
                  WHEN bool_or(ar.normalized_name = $1) THEN 85
                  WHEN s.normalized_title LIKE $2 OR similarity(s.normalized_title, $1) > 0.25 THEN 70
                  WHEN s.normalized_primary_artist_name LIKE $2 OR bool_or(ar.normalized_name LIKE $2) THEN 60
                  WHEN s.title_pinyin LIKE $2 OR bool_or(ar.name_pinyin LIKE $2) THEN 50
                  WHEN s.title_initials LIKE $2 OR bool_or(ar.name_initials LIKE $2) THEN 45
                  WHEN EXISTS (
                    SELECT 1
                    FROM ktv_song_style_tags st
                    JOIN ktv_style_tags t ON t.id = st.tag_id AND t.enabled = true
                    WHERE st.song_id = s.id
                      AND (t.normalized_name LIKE $2 OR t.name ILIKE $3)
                  ) THEN 35
                  ELSE 0
                END AS score,
                CASE
                  WHEN $1 = '' THEN 'default'
                  WHEN s.normalized_title = $1 THEN 'title'
                  WHEN s.normalized_primary_artist_name = $1 OR bool_or(ar.normalized_name = $1) THEN 'artist'
                  WHEN s.normalized_title LIKE $2 OR similarity(s.normalized_title, $1) > 0.25 THEN 'normalized_title'
                  WHEN s.normalized_primary_artist_name LIKE $2 OR bool_or(ar.normalized_name LIKE $2) THEN 'artist'
                  WHEN s.title_pinyin LIKE $2 OR bool_or(ar.name_pinyin LIKE $2) THEN 'pinyin'
                  WHEN s.title_initials LIKE $2 OR bool_or(ar.name_initials LIKE $2) THEN 'initials'
                  WHEN EXISTS (
                    SELECT 1
                    FROM ktv_song_style_tags st
                    JOIN ktv_style_tags t ON t.id = st.tag_id AND t.enabled = true
                    WHERE st.song_id = s.id
                      AND (t.normalized_name LIKE $2 OR t.name ILIKE $3)
                  ) THEN 'style'
                  ELSE 'default'
                END AS match_reason
         FROM ktv_songs s
         JOIN ktv_song_assets active_asset ON active_asset.song_id = s.id AND active_asset.missing_at IS NULL
         LEFT JOIN ktv_song_artists sa ON sa.song_id = s.id
         LEFT JOIN ktv_artists ar ON ar.id = sa.artist_id
         WHERE $1 = ''
            OR s.normalized_title = $1
            OR s.normalized_title LIKE $2
            OR similarity(s.normalized_title, $1) > 0.25
            OR s.title_pinyin LIKE $2
            OR s.title_initials LIKE $2
            OR s.normalized_primary_artist_name LIKE $2
            OR ar.normalized_name LIKE $2
            OR ar.name_pinyin LIKE $2
            OR ar.name_initials LIKE $2
            OR EXISTS (
              SELECT 1
              FROM ktv_song_style_tags st
              JOIN ktv_style_tags t ON t.id = st.tag_id AND t.enabled = true
              WHERE st.song_id = s.id
                AND (t.normalized_name LIKE $2 OR t.name ILIKE $3)
            )
         GROUP BY s.id, s.title, s.primary_artist_name, s.normalized_title,
                  s.normalized_primary_artist_name, s.title_pinyin, s.title_initials
         ORDER BY ${matchedSongOrder}
         LIMIT $4
       ),
       ranked_assets AS (
         SELECT ms.song_id,
                ms.title,
                ms.primary_artist_name,
                ms.style_tags,
                ms.match_reason,
                ms.score,
                a.id AS asset_id,
                a.file_name,
                a.file_path,
                a.extension,
                a.size_bytes,
                a.parse_confidence,
                a.technical_metadata,
                a.missing_at,
                row_number() OVER (PARTITION BY ms.song_id ORDER BY a.updated_at DESC, a.file_path ASC) AS asset_rank
         FROM matched_songs ms
         JOIN ktv_song_assets a ON a.song_id = ms.song_id
         WHERE a.missing_at IS NULL
       )
       SELECT song_id,
              title,
              primary_artist_name,
              style_tags,
              match_reason,
              score,
              asset_id,
              file_name,
              file_path,
              extension,
              size_bytes,
              parse_confidence,
              technical_metadata,
              missing_at
       FROM ranked_assets
       WHERE asset_rank <= $5
       ORDER BY score DESC, title ASC, primary_artist_name ASC, file_name ASC`,
      [normalizedQuery, likeQuery, tagQuery, limit, versionsPerSong]
    );

    return result.rows;
  }

  private async getTableAvailability(): Promise<KtvIndexTableAvailability[]> {
    const result = await this.db.query<{ table_name: KtvTableName; exists: boolean }>(
      `SELECT expected.table_name,
              to_regclass('public.' || expected.table_name) IS NOT NULL AS exists
       FROM (VALUES ${ktvTableNames.map((_, index) => `($${index + 1}::text)`).join(", ")}) AS expected(table_name)`,
      ktvTableNames
    );

    const byTable = new Map(result.rows.map((row) => [row.table_name, row.exists]));
    return ktvTableNames.map((tableName) => ({
      tableName,
      exists: byTable.get(tableName) === true
    }));
  }

  private async getLatestRun(): Promise<KtvIndexRunSummary | null> {
    const result = await this.db.query<LatestRunRow>(
      `SELECT id, source_root, ssh_host, status, files_seen, songs_upserted, assets_upserted,
              error_message, started_at, finished_at
       FROM ktv_index_runs
       ORDER BY started_at DESC
       LIMIT 1`
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      sourceRoot: row.source_root,
      sshHost: row.ssh_host,
      status: row.status,
      filesSeen: toNumber(row.files_seen),
      songsUpserted: toNumber(row.songs_upserted),
      assetsUpserted: toNumber(row.assets_upserted),
      errorMessage: row.error_message,
      startedAt: toIsoString(row.started_at),
      finishedAt: row.finished_at ? toIsoString(row.finished_at) : null
    };
  }

  private async getCounts(): Promise<{
    activeAssetCount: number;
    missingAssetCount: number;
    songCount: number;
    artistCount: number;
  }> {
    const result = await this.db.query<CountRow>(
      `SELECT count(*) FILTER (WHERE a.missing_at IS NULL) AS active_asset_count,
              count(*) FILTER (WHERE a.missing_at IS NOT NULL) AS missing_asset_count,
              (SELECT count(*) FROM ktv_songs) AS song_count,
              (SELECT count(*) FROM ktv_artists) AS artist_count
       FROM ktv_song_assets a`
    );
    const row = result.rows[0];
    return {
      activeAssetCount: toNumber(row?.active_asset_count ?? 0),
      missingAssetCount: toNumber(row?.missing_asset_count ?? 0),
      songCount: toNumber(row?.song_count ?? 0),
      artistCount: toNumber(row?.artist_count ?? 0)
    };
  }

  private async getParseStrategies(): Promise<KtvIndexDiagnosticsResponse["parseStrategies"]> {
    const result = await this.db.query<ParseStrategyRow>(
      `SELECT parse_strategy, count(*)::int AS count
       FROM ktv_song_assets
       WHERE missing_at IS NULL
       GROUP BY parse_strategy
       ORDER BY count DESC, parse_strategy ASC`
    );
    return result.rows.map((row) => ({
      parseStrategy: row.parse_strategy,
      count: toNumber(row.count)
    }));
  }

  private async getTechnicalStatusCounts(): Promise<KtvIndexDiagnosticsResponse["technicalStatusCounts"]> {
    const result = await this.db.query<TechnicalStatusRow>(
      `SELECT technical_status, count(*)::int AS count
       FROM ktv_song_assets
       WHERE missing_at IS NULL
       GROUP BY technical_status
       ORDER BY technical_status ASC`
    );
    return result.rows.map((row) => ({
      technicalStatus: row.technical_status ?? "unknown",
      count: toNumber(row.count)
    }));
  }

  private async getAudioTrackDistribution(): Promise<KtvIndexDiagnosticsResponse["audioTrackDistribution"]> {
    const result = await this.db.query<AudioTrackDistributionRow>(
      `WITH track_arrays AS (
         SELECT coalesce(technical_metadata->'mediaInfoSummary'->'audioTracks', technical_metadata->'audioTracks') AS audio_tracks
         FROM ktv_song_assets
         WHERE missing_at IS NULL
       )
       SELECT jsonb_array_length(audio_tracks)::int AS audio_track_count,
              count(*)::int AS count
       FROM track_arrays
       WHERE jsonb_typeof(audio_tracks) = 'array'
       GROUP BY audio_track_count
       ORDER BY audio_track_count ASC`
    );
    return result.rows.map((row) => ({
      audioTrackCount: toNumber(row.audio_track_count),
      count: toNumber(row.count)
    }));
  }

  private async getConfidenceSummary(): Promise<{ lowConfidenceCount: number; minParseConfidence: number | null }> {
    const result = await this.db.query<ConfidenceRow>(
      `SELECT count(*) FILTER (WHERE parse_confidence < 0.75)::int AS low_confidence_count,
              min(parse_confidence) AS min_parse_confidence
       FROM ktv_song_assets
       WHERE missing_at IS NULL`
    );
    const row = result.rows[0];
    return {
      lowConfidenceCount: toNumber(row?.low_confidence_count ?? 0),
      minParseConfidence: row?.min_parse_confidence == null ? null : toNumber(row.min_parse_confidence)
    };
  }

  private async searchDiagnosticsPreview(input: SearchKtvIndexedSongsInput): Promise<KtvIndexDiagnosticsPreviewResult[]> {
    const rows = await this.queryIndexedRows(input);
    return mapDiagnosticsPreviewRows(rows);
  }

  private async getSampleAssets(input: GetKtvIndexDiagnosticsInput): Promise<SampleAssetRow[]> {
    const sampleSize = Math.min(50, Math.max(0, input.sampleSize ?? 12));
    if (sampleSize === 0) {
      return [];
    }

    const orderBy = input.deterministicSample ? "updated_at DESC" : "random()";
    const result = await this.db.query<SampleAssetRow>(
      `SELECT id, file_path
       FROM ktv_song_assets
       WHERE missing_at IS NULL
       ORDER BY ${orderBy}
       LIMIT $1`,
      [sampleSize]
    );
    return result.rows;
  }
}

function mapIndexedSearchRows(
  rows: readonly IndexedSearchRow[],
  input: Pick<SearchKtvIndexedSongsInput, "queuedIndexedAssetIds" | "unreadableIndexedAssetIds">
): SongSearchIndexedResult[] {
  const queuedIndexedAssetIds = new Set(input.queuedIndexedAssetIds ?? []);
  const unreadableIndexedAssetIds = new Set(input.unreadableIndexedAssetIds ?? []);

  return mapGroupedRows(rows, (row): SongSearchIndexedVersionOption => {
    const indexedAssetId = row.asset_id;
    const unreadable = unreadableIndexedAssetIds.has(indexedAssetId);
    const queued = queuedIndexedAssetIds.has(indexedAssetId);

    return {
      indexedAssetId,
      displayName: row.file_name,
      sourceLabel: "KTV索引",
      extension: row.extension,
      sizeBytes: toNullableNumber(row.size_bytes),
      audioTrackCount: readAudioTrackCount(row.technical_metadata),
      styleTags: normalizeStyleTags(row.style_tags),
      category: displayCategory(row.style_tags),
      queueState: unreadable ? "file_unreadable" : queued ? "queued" : "not_queued",
      canQueue: !unreadable,
      disabledLabel: unreadable ? "文件不可读" : null
    };
  });
}

function mapDiagnosticsPreviewRows(rows: readonly IndexedSearchRow[]): KtvIndexDiagnosticsPreviewResult[] {
  return mapGroupedRows(rows, (row) => ({
    indexedAssetId: row.asset_id,
    displayName: row.file_name,
    sourceLabel: "KTV索引",
    extension: row.extension,
    sizeBytes: toNullableNumber(row.size_bytes),
    styleTags: normalizeStyleTags(row.style_tags),
    category: displayCategory(row.style_tags),
    parseConfidence: toNumber(row.parse_confidence),
    filePath: row.file_path,
    missingAt: row.missing_at ? toIsoString(row.missing_at) : null
  }));
}

function mapGroupedRows<TVersion>(
  rows: readonly IndexedSearchRow[],
  mapVersion: (row: IndexedSearchRow) => TVersion
): Array<Omit<SongSearchIndexedResult, "versions"> & { versions: TVersion[] }> {
  const bySongId = new Map<string, Array<IndexedSearchRow>>();
  for (const row of rows) {
    const songRows = bySongId.get(row.song_id) ?? [];
    songRows.push(row);
    bySongId.set(row.song_id, songRows);
  }

  return Array.from(bySongId.values()).map((songRows) => {
    const first = songRows[0]!;
    return {
      indexedSongId: first.song_id,
      title: first.title,
      artistName: first.primary_artist_name,
      styleTags: normalizeStyleTags(first.style_tags),
      category: displayCategory(first.style_tags),
      sourceLabel: "KTV索引",
      matchReason: first.match_reason,
      versions: songRows.map(mapVersion)
    };
  });
}

function createEmptyNasSample(): KtvIndexDiagnosticsResponse["nasSample"] {
  return {
    requested: 0,
    checked: 0,
    readable: 0,
    missing: 0,
    unreadable: 0,
    timeout: 0,
    unmapped: 0,
    results: [] satisfies KtvIndexNasSampleResult[]
  };
}

function toNumber(value: number | string): number {
  return typeof value === "number" ? value : Number.parseFloat(value);
}

function toNullableNumber(value: number | string | null): number | null {
  return value == null ? null : toNumber(value);
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function normalizeStyleTags(value: readonly string[] | null): string[] {
  return Array.isArray(value) ? value.filter((tag) => tag.trim().length > 0) : [];
}

function displayCategory(value: readonly string[] | null): string {
  return normalizeStyleTags(value)[0] ?? "未打标签";
}

function countTechnicalStatus(
  rows: KtvIndexDiagnosticsResponse["technicalStatusCounts"],
  technicalStatus: string
): number {
  return rows.find((row) => row.technicalStatus === technicalStatus)?.count ?? 0;
}

function calculateProbeCoveragePercent(input: { activeAssetCount: number; probedCount: number }): number {
  if (input.activeAssetCount <= 0) {
    return 0;
  }
  return Math.round((input.probedCount / input.activeAssetCount) * 10_000) / 100;
}

function readAudioTrackCount(value: unknown): number | null {
  if (!isRecord(value)) {
    return null;
  }

  const mediaInfoSummary = isRecord(value.mediaInfoSummary) ? value.mediaInfoSummary : value;
  const audioTracks = mediaInfoSummary.audioTracks;
  if (!Array.isArray(audioTracks)) {
    return null;
  }
  return audioTracks.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
