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

export interface KtvIndexDiscoveryArtistSummary {
  artistId: string;
  artistName: string;
  songCount: number;
  playCount: number;
}

export interface KtvIndexDiscoveryGenreSummary {
  genre: string;
  songCount: number;
  playCount: number;
}

export interface ListKtvIndexedSongsByArtistInput {
  artistId: string;
  limit?: number;
  offset?: number;
  queuedIndexedAssetIds?: readonly string[];
  unreadableIndexedAssetIds?: readonly string[];
}

export interface ListKtvIndexedSongsByGenreInput {
  genre: string;
  limit?: number;
  offset?: number;
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
  listDiscoveryArtists?(): Promise<KtvIndexDiscoveryArtistSummary[]>;
  listDiscoveryGenres?(): Promise<KtvIndexDiscoveryGenreSummary[]>;
  listIndexedSongsByArtist?(input: ListKtvIndexedSongsByArtistInput): Promise<SongSearchIndexedResult[]>;
  listIndexedSongsByGenre?(input: ListKtvIndexedSongsByGenreInput): Promise<SongSearchIndexedResult[]>;
  getDiagnostics(input?: GetKtvIndexDiagnosticsInput): Promise<KtvIndexDiagnosticsResponse>;
}

export interface KtvIndexReadRepositoryOptions {
  pathMappings?: readonly MediaPathMapping[];
}

type KtvTableName = KtvIndexTableAvailability["tableName"];

const ktvTableNames = ["ktv_songs"] as const satisfies readonly KtvTableName[];

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

interface DiscoveryArtistSummaryRow {
  artist_id: string;
  artist_name: string;
  song_count: number | string;
  play_count: number | string;
}

interface DiscoveryGenreSummaryRow {
  genre: string;
  song_count: number | string;
  play_count: number | string;
}

const untaggedDiscoveryGenre = "未打标签";

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

  async listDiscoveryArtists(): Promise<KtvIndexDiscoveryArtistSummary[]> {
    const result = await this.db.query<DiscoveryArtistSummaryRow>(
      `WITH song_artists AS (
         SELECT s.id AS song_id,
                s.request_count,
                artist.artist_name
         FROM ktv_songs s
         CROSS JOIN LATERAL unnest(
           CASE
             WHEN cardinality(s.artist_names) > 0 THEN s.artist_names
             ELSE ARRAY[s.primary_artist_name]::text[]
           END
         ) AS artist(artist_name)
         WHERE s.missing_at IS NULL
       )
       SELECT artist_name AS artist_id,
              artist_name,
              count(DISTINCT song_id)::int AS song_count,
              coalesce(sum(request_count), 0)::int AS play_count
       FROM song_artists
       WHERE length(trim(artist_name)) > 0
       GROUP BY artist_name
       ORDER BY song_count DESC, play_count DESC, artist_name ASC`
    );

    return result.rows.map((row) => ({
      artistId: row.artist_id,
      artistName: row.artist_name,
      songCount: toNumber(row.song_count),
      playCount: toNumber(row.play_count)
    }));
  }

  async listDiscoveryGenres(): Promise<KtvIndexDiscoveryGenreSummary[]> {
    const result = await this.db.query<DiscoveryGenreSummaryRow>(
      `WITH active_songs AS (
         SELECT s.id AS song_id,
                s.request_count,
                s.style_tags
         FROM ktv_songs s
         WHERE s.missing_at IS NULL
       ),
       genre_catalog AS (
         SELECT DISTINCT tag_name AS genre,
                active_songs.song_id,
                active_songs.request_count
         FROM active_songs
         CROSS JOIN LATERAL unnest(active_songs.style_tags) AS tag(tag_name)
         WHERE length(trim(tag_name)) > 0
         UNION ALL
         SELECT $1::text AS genre,
                active_songs.song_id,
                active_songs.request_count
         FROM active_songs
         WHERE NOT EXISTS (
           SELECT 1
           FROM unnest(active_songs.style_tags) AS tag(tag_name)
           WHERE length(trim(tag_name)) > 0
         )
       )
       SELECT genre,
              count(DISTINCT song_id)::int AS song_count,
              coalesce(sum(request_count), 0)::int AS play_count
       FROM genre_catalog
       GROUP BY genre
       ORDER BY song_count DESC, play_count DESC, genre ASC`,
      [untaggedDiscoveryGenre]
    );

    return result.rows.map((row) => ({
      genre: row.genre,
      songCount: toNumber(row.song_count),
      playCount: toNumber(row.play_count)
    }));
  }

  async listIndexedSongsByArtist(input: ListKtvIndexedSongsByArtistInput): Promise<SongSearchIndexedResult[]> {
    const rows = await this.queryIndexedRowsByArtist(input);
    return mapIndexedSearchRows(rows, {
      queuedIndexedAssetIds: input.queuedIndexedAssetIds ?? [],
      unreadableIndexedAssetIds: input.unreadableIndexedAssetIds ?? []
    });
  }

  async listIndexedSongsByGenre(input: ListKtvIndexedSongsByGenreInput): Promise<SongSearchIndexedResult[]> {
    const rows = await this.queryIndexedRowsByGenre(input);
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
    const matchedSongOrder = input.shuffle
      ? "random(), score DESC, title ASC, primary_artist_name ASC"
      : "score DESC, title ASC, primary_artist_name ASC";

    const result = await this.db.query<IndexedSearchRow>(
      `SELECT s.id AS song_id,
              s.title,
              s.primary_artist_name,
              s.style_tags,
              CASE
                WHEN $1 = '' THEN 1
                WHEN s.normalized_title = $1 THEN 100
                WHEN s.normalized_primary_artist_name = $1 THEN 90
                WHEN EXISTS (SELECT 1 FROM unnest(s.artist_names) AS artist(artist_name) WHERE replace(lower(artist_name), ' ', '') = $1) THEN 85
                WHEN s.normalized_title LIKE $2 OR similarity(s.normalized_title, $1) > 0.25 THEN 70
                WHEN s.normalized_primary_artist_name LIKE $2
                  OR EXISTS (SELECT 1 FROM unnest(s.artist_names) AS artist(artist_name) WHERE replace(lower(artist_name), ' ', '') LIKE $2 OR artist_name ILIKE $3) THEN 60
                WHEN s.title_pinyin LIKE $2 THEN 50
                WHEN s.title_initials LIKE $2 THEN 45
                WHEN EXISTS (SELECT 1 FROM unnest(s.style_tags) AS tag(tag_name) WHERE replace(lower(tag_name), ' ', '') LIKE $2 OR tag_name ILIKE $3) THEN 35
                ELSE 0
              END AS score,
              CASE
                WHEN $1 = '' THEN 'default'
                WHEN s.normalized_title = $1 THEN 'title'
                WHEN s.normalized_primary_artist_name = $1
                  OR EXISTS (SELECT 1 FROM unnest(s.artist_names) AS artist(artist_name) WHERE replace(lower(artist_name), ' ', '') = $1) THEN 'artist'
                WHEN s.normalized_title LIKE $2 OR similarity(s.normalized_title, $1) > 0.25 THEN 'normalized_title'
                WHEN s.normalized_primary_artist_name LIKE $2
                  OR EXISTS (SELECT 1 FROM unnest(s.artist_names) AS artist(artist_name) WHERE replace(lower(artist_name), ' ', '') LIKE $2 OR artist_name ILIKE $3) THEN 'artist'
                WHEN s.title_pinyin LIKE $2 THEN 'pinyin'
                WHEN s.title_initials LIKE $2 THEN 'initials'
                WHEN EXISTS (SELECT 1 FROM unnest(s.style_tags) AS tag(tag_name) WHERE replace(lower(tag_name), ' ', '') LIKE $2 OR tag_name ILIKE $3) THEN 'style'
                ELSE 'default'
              END AS match_reason,
              s.id AS asset_id,
              s.file_name,
              s.file_path,
              s.extension,
              s.size_bytes,
              s.parse_confidence,
              s.technical_metadata,
              s.missing_at
       FROM ktv_songs s
       WHERE s.missing_at IS NULL
         AND (
           $1 = ''
           OR s.normalized_title = $1
           OR s.normalized_title LIKE $2
           OR similarity(s.normalized_title, $1) > 0.25
           OR s.title_pinyin LIKE $2
           OR s.title_initials LIKE $2
           OR s.normalized_primary_artist_name LIKE $2
           OR EXISTS (SELECT 1 FROM unnest(s.artist_names) AS artist(artist_name) WHERE replace(lower(artist_name), ' ', '') LIKE $2 OR artist_name ILIKE $3)
           OR EXISTS (SELECT 1 FROM unnest(s.style_tags) AS tag(tag_name) WHERE replace(lower(tag_name), ' ', '') LIKE $2 OR tag_name ILIKE $3)
         )
       ORDER BY ${matchedSongOrder}
       LIMIT $4`,
      [normalizedQuery, likeQuery, tagQuery, limit]
    );

    return result.rows;
  }

  private async queryIndexedRowsByArtist(input: ListKtvIndexedSongsByArtistInput): Promise<IndexedSearchRow[]> {
    const limit = discoverySongPageLimit(input.limit);
    const offset = discoverySongPageOffset(input.offset);
    const result = await this.db.query<IndexedSearchRow>(
      `SELECT s.id AS song_id,
              s.title,
              s.primary_artist_name,
              s.style_tags,
              'artist'::text AS match_reason,
              s.request_count AS score,
              s.id AS asset_id,
              s.file_name,
              s.file_path,
              s.extension,
              s.size_bytes,
              s.parse_confidence,
              s.technical_metadata,
              s.missing_at
       FROM ktv_songs s
       WHERE s.missing_at IS NULL
         AND $1 = ANY(
           CASE
             WHEN cardinality(s.artist_names) > 0 THEN s.artist_names
             ELSE ARRAY[s.primary_artist_name]::text[]
           END
         )
       ORDER BY s.request_count DESC, s.last_requested_at DESC NULLS LAST, s.title ASC, s.primary_artist_name ASC, s.file_name ASC
       LIMIT $2 OFFSET $3`,
      [input.artistId, limit, offset]
    );

    return result.rows;
  }

  private async queryIndexedRowsByGenre(input: ListKtvIndexedSongsByGenreInput): Promise<IndexedSearchRow[]> {
    const limit = discoverySongPageLimit(input.limit);
    const offset = discoverySongPageOffset(input.offset);
    const isUntagged = input.genre === untaggedDiscoveryGenre;
    const genreWhere = isUntagged
      ? "AND NOT EXISTS (SELECT 1 FROM unnest(s.style_tags) AS tag(tag_name) WHERE length(trim(tag_name)) > 0)"
      : "AND $1 = ANY(s.style_tags)";
    const values = isUntagged ? [limit, offset] : [input.genre, limit, offset];
    const limitParam = isUntagged ? "$1" : "$2";
    const offsetParam = isUntagged ? "$2" : "$3";
    const result = await this.db.query<IndexedSearchRow>(
      `SELECT s.id AS song_id,
              s.title,
              s.primary_artist_name,
              s.style_tags,
              'style'::text AS match_reason,
              s.request_count AS score,
              s.id AS asset_id,
              s.file_name,
              s.file_path,
              s.extension,
              s.size_bytes,
              s.parse_confidence,
              s.technical_metadata,
              s.missing_at
       FROM ktv_songs s
       WHERE s.missing_at IS NULL
         ${genreWhere}
       ORDER BY s.request_count DESC, s.last_requested_at DESC NULLS LAST, s.title ASC, s.primary_artist_name ASC, s.file_name ASC
       LIMIT ${limitParam} OFFSET ${offsetParam}`,
      values
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
      `WITH latest_run AS (
         SELECT last_seen_run_id AS id,
                max(source_root) AS source_root,
                max(ssh_host) AS ssh_host,
                count(*)::int AS files_seen,
                count(*)::int AS songs_upserted,
                count(*)::int AS assets_upserted,
                max(updated_at) AS finished_at
         FROM ktv_songs
         WHERE last_seen_run_id IS NOT NULL
         GROUP BY last_seen_run_id
         ORDER BY max(updated_at) DESC, last_seen_run_id DESC
         LIMIT 1
       )
       SELECT id,
              source_root,
              ssh_host,
              'completed'::text AS status,
              files_seen,
              songs_upserted,
              assets_upserted,
              NULL::text AS error_message,
              finished_at AS started_at,
              finished_at
       FROM latest_run`
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
      `SELECT count(*) FILTER (WHERE s.missing_at IS NULL) AS active_asset_count,
              count(*) FILTER (WHERE s.missing_at IS NOT NULL) AS missing_asset_count,
              (SELECT count(*) FROM ktv_songs s2 WHERE s2.missing_at IS NULL) AS song_count,
              (SELECT count(DISTINCT artist_name)
               FROM ktv_songs s3
               CROSS JOIN LATERAL unnest(
                 CASE
                   WHEN cardinality(s3.artist_names) > 0 THEN s3.artist_names
                   ELSE ARRAY[s3.primary_artist_name]::text[]
                 END
               ) AS artist(artist_name)
               WHERE s3.missing_at IS NULL AND length(trim(artist_name)) > 0) AS artist_count
       FROM ktv_songs s`
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
       FROM ktv_songs
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
       FROM ktv_songs
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
         FROM ktv_songs
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
       FROM ktv_songs
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
       FROM ktv_songs
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

function discoverySongPageLimit(value: number | undefined): number {
  return Math.min(100, Math.max(1, typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 60));
}

function discoverySongPageOffset(value: number | undefined): number {
  return Math.max(0, typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0);
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
