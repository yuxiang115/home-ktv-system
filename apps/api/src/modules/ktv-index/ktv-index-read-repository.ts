import type {
  AdminDashboardChartPoint,
  AdminDashboardLargestSong,
  AdminDashboardRecentRequest,
  AdminDashboardRequestTrendPoint,
  AdminDashboardResponse,
  AdminDashboardSongRank,
  AdminDashboardTrendRange,
  AdminDashboardUserRank,
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

export interface GetAdminDashboardInput {
  trendRange?: AdminDashboardTrendRange;
}

export interface KtvIndexReadRepository {
  searchIndexedSongs(input: SearchKtvIndexedSongsInput): Promise<SongSearchIndexedResult[]>;
  listDiscoveryArtists?(): Promise<KtvIndexDiscoveryArtistSummary[]>;
  listDiscoveryGenres?(): Promise<KtvIndexDiscoveryGenreSummary[]>;
  listIndexedSongsByArtist?(input: ListKtvIndexedSongsByArtistInput): Promise<SongSearchIndexedResult[]>;
  listIndexedSongsByGenre?(input: ListKtvIndexedSongsByGenreInput): Promise<SongSearchIndexedResult[]>;
  getDiagnostics(input?: GetKtvIndexDiagnosticsInput): Promise<KtvIndexDiagnosticsResponse>;
  getAdminDashboard(input?: GetAdminDashboardInput): Promise<AdminDashboardResponse>;
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
  total_size_bytes?: number | string | null;
  tagged_song_count?: number | string;
  cover_count?: number | string;
  user_count?: number | string;
  queue_entry_count?: number | string;
  total_song_request_count?: number | string;
  recent_queue_entry_count?: number | string;
  latest_requested_at?: Date | string | null;
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

interface DashboardCountRow {
  active_asset_count: number | string;
  missing_asset_count: number | string;
  song_count: number | string;
  artist_count: number | string;
  total_size_bytes: number | string | null;
  tagged_song_count: number | string;
  cover_count: number | string;
  user_count: number | string;
  queue_entry_count: number | string;
  total_song_request_count: number | string;
  recent_queue_entry_count: number | string;
  latest_requested_at: Date | string | null;
}

interface DashboardLabelCountRow {
  label: string | null;
  count: number | string;
}

interface DashboardLargestSongRow {
  song_id: string;
  title: string;
  artist_name: string;
  file_name: string;
  extension: string | null;
  size_bytes: number | string | null;
}

interface DashboardTrendRow {
  date: string | Date;
  request_count: number | string;
  unique_requester_count: number | string;
}

interface RequestTrendConfig {
  grain: "day" | "week" | "month";
  lookbackInterval: string;
  stepInterval: string;
  dateFormat: string;
}

interface DashboardSongRankRow {
  song_id: string;
  title: string;
  artist_name: string;
  request_count: number | string;
  last_requested_at: Date | string | null;
}

interface DashboardUserRankRow {
  requester_id: string | null;
  display_name: string | null;
  request_count: number | string;
  unique_song_count: number | string;
  last_requested_at: Date | string | null;
}

interface DashboardRecentRequestRow {
  queue_entry_id: string;
  song_id: string | null;
  title: string | null;
  artist_name: string | null;
  requester_name: string | null;
  requested_at: Date | string;
  status: AdminDashboardRecentRequest["status"];
}

const untaggedDiscoveryGenre = "未打标签";

const requestTrendConfigs: Record<AdminDashboardTrendRange, RequestTrendConfig> = {
  "7d": {
    grain: "day",
    lookbackInterval: "6 days",
    stepInterval: "1 day",
    dateFormat: "YYYY-MM-DD"
  },
  "30d": {
    grain: "day",
    lookbackInterval: "29 days",
    stepInterval: "1 day",
    dateFormat: "YYYY-MM-DD"
  },
  "3m": {
    grain: "week",
    lookbackInterval: "3 months",
    stepInterval: "1 week",
    dateFormat: "YYYY-MM-DD"
  },
  "1y": {
    grain: "month",
    lookbackInterval: "11 months",
    stepInterval: "1 month",
    dateFormat: "YYYY-MM"
  }
};

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

  async getAdminDashboard(input: GetAdminDashboardInput = {}): Promise<AdminDashboardResponse> {
    const trendRange = normalizeDashboardTrendRange(input.trendRange);
    const tables = await this.getTableAvailability();
    const emptyDashboard = createEmptyAdminDashboard(tables);
    if (!tables.every((table) => table.exists)) {
      return emptyDashboard;
    }

    const [
      latestRun,
      counts,
      parseStrategies,
      technicalStatusCounts,
      audioTrackDistribution,
      audioCodecDistribution,
      videoCodecDistribution,
      videoResolutionDistribution,
      confidence,
      sizeBuckets,
      extensionDistribution,
      largestSongs,
      topArtists,
      topStyles,
      requestStatusDistribution,
      requestTrend,
      topSongs,
      topRequestedArtists,
      topRequesters,
      recentRequests
    ] = await Promise.all([
      this.getLatestRun(),
      this.getDashboardCounts(),
      this.getParseStrategies(),
      this.getTechnicalStatusCounts(),
      this.getAudioTrackDistribution(),
      this.getAudioCodecDistribution(),
      this.getVideoCodecDistribution(),
      this.getVideoResolutionDistribution(),
      this.getConfidenceSummary(),
      this.getSizeBuckets(),
      this.getExtensionDistribution(),
      this.getLargestSongs(),
      this.getDashboardTopArtists(),
      this.getTopStyles(),
      this.getRequestStatusDistribution(),
      this.getRequestTrend(trendRange),
      this.getTopRequestedSongs(),
      this.getTopRequestedArtists(),
      this.getTopRequesters(),
      this.getRecentRequests()
    ]);

    const probedCount = countTechnicalStatus(technicalStatusCounts, "probed");
    const probeCoveragePercent = calculateProbeCoveragePercent({
      activeAssetCount: counts.activeAssetCount,
      probedCount
    });
    return {
      generatedAt: new Date().toISOString(),
      metrics: [
        { id: "songs", label: "总歌曲数", value: counts.songCount, unit: "首", trendLabel: null },
        { id: "artists", label: "歌手数", value: counts.artistCount, unit: "位", trendLabel: null },
        { id: "storage", label: "总存储", value: counts.totalSizeBytes, unit: "bytes", trendLabel: null },
        {
          id: "requests",
          label: "累计点歌",
          value: counts.queueEntryCount,
          unit: "次",
          trendLabel: `近 30 天 ${counts.recentQueueEntryCount} 次`
        },
        { id: "users", label: "用户数", value: counts.userCount, unit: "人", trendLabel: null },
        {
          id: "coverage",
          label: "探测覆盖",
          value: probeCoveragePercent,
          unit: "percent",
          trendLabel: `待探测 ${countTechnicalStatus(technicalStatusCounts, "pending")}`
        }
      ],
      health: {
        latestRun,
        sourceRoot: latestRun?.sourceRoot ?? null,
        probeCoveragePercent,
        lowConfidenceCount: confidence.lowConfidenceCount,
        missingAssetCount: counts.missingAssetCount
      },
      storage: {
        totalBytes: counts.totalSizeBytes,
        sizeBuckets,
        extensionDistribution,
        largestSongs
      },
      catalog: {
        topArtists,
        topStyles,
        parseStrategies: parseStrategies.map((row) => ({ label: row.parseStrategy, value: row.count })),
        technicalStatus: technicalStatusCounts.map((row) => ({ label: row.technicalStatus, value: row.count })),
        audioTrackDistribution: audioTrackDistribution.map((row) => ({
          label: `${row.audioTrackCount} 条音轨`,
          value: row.count
        })),
        audioCodecDistribution,
        videoCodecDistribution,
        videoResolutionDistribution
      },
      requests: {
        totalQueueEntries: counts.queueEntryCount,
        totalSongRequests: counts.totalSongRequestCount,
        requestTrend,
        statusDistribution: requestStatusDistribution,
        topSongs,
        topArtists: topRequestedArtists,
        topRequesters,
        recentRequests
      }
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

  private async getDashboardCounts(): Promise<{
    activeAssetCount: number;
    missingAssetCount: number;
    songCount: number;
    artistCount: number;
    totalSizeBytes: number;
    taggedSongCount: number;
    coverCount: number;
    userCount: number;
    queueEntryCount: number;
    totalSongRequestCount: number;
    recentQueueEntryCount: number;
    latestRequestedAt: string | null;
  }> {
    const result = await this.db.query<DashboardCountRow>(
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
               WHERE s3.missing_at IS NULL AND length(trim(artist_name)) > 0) AS artist_count,
              coalesce(sum(s.size_bytes) FILTER (WHERE s.missing_at IS NULL), 0) AS total_size_bytes,
              count(*) FILTER (
                WHERE s.missing_at IS NULL
                  AND EXISTS (SELECT 1 FROM unnest(s.style_tags) AS tag(tag_name) WHERE length(trim(tag_name)) > 0)
              ) AS tagged_song_count,
              count(*) FILTER (WHERE s.missing_at IS NULL AND s.cover_image_url IS NOT NULL) AS cover_count,
              (SELECT count(*) FROM controller_users) AS user_count,
              (SELECT count(*) FROM queue_entries) AS queue_entry_count,
              coalesce(sum(s.request_count) FILTER (WHERE s.missing_at IS NULL), 0) AS total_song_request_count,
              (SELECT count(*) FROM queue_entries WHERE requested_at >= now() - interval '30 days') AS recent_queue_entry_count,
              (SELECT max(requested_at) FROM queue_entries) AS latest_requested_at
       FROM ktv_songs s`
    );
    const row = result.rows[0];
    return {
      activeAssetCount: toNumber(row?.active_asset_count ?? 0),
      missingAssetCount: toNumber(row?.missing_asset_count ?? 0),
      songCount: toNumber(row?.song_count ?? 0),
      artistCount: toNumber(row?.artist_count ?? 0),
      totalSizeBytes: toNumber(row?.total_size_bytes ?? 0),
      taggedSongCount: toNumber(row?.tagged_song_count ?? 0),
      coverCount: toNumber(row?.cover_count ?? 0),
      userCount: toNumber(row?.user_count ?? 0),
      queueEntryCount: toNumber(row?.queue_entry_count ?? 0),
      totalSongRequestCount: toNumber(row?.total_song_request_count ?? 0),
      recentQueueEntryCount: toNumber(row?.recent_queue_entry_count ?? 0),
      latestRequestedAt: row?.latest_requested_at ? toIsoString(row.latest_requested_at) : null
    };
  }

  private async getSizeBuckets(): Promise<AdminDashboardChartPoint[]> {
    const result = await this.db.query<DashboardLabelCountRow>(
      `WITH bucketed AS (
         SELECT CASE
                  WHEN size_bytes IS NULL THEN '未知'
                  WHEN size_bytes < 52428800::bigint THEN '50MB 以下'
                  WHEN size_bytes < 104857600::bigint THEN '50-100MB'
                  WHEN size_bytes < 209715200::bigint THEN '100-200MB'
                  WHEN size_bytes < 314572800::bigint THEN '200-300MB'
                  WHEN size_bytes < 524288000::bigint THEN '300-500MB'
                  ELSE '500MB 以上'
                END AS size_bucket,
                CASE
                  WHEN size_bytes IS NULL THEN 0
                  WHEN size_bytes < 52428800::bigint THEN 1
                  WHEN size_bytes < 104857600::bigint THEN 2
                  WHEN size_bytes < 209715200::bigint THEN 3
                  WHEN size_bytes < 314572800::bigint THEN 4
                  WHEN size_bytes < 524288000::bigint THEN 5
                  ELSE 6
                END AS sort_order
         FROM ktv_songs
         WHERE missing_at IS NULL
       )
       SELECT size_bucket AS label, count(*)::int AS count
       FROM bucketed
       GROUP BY size_bucket, sort_order
       ORDER BY sort_order ASC`
    );
    return mapLabelCountRows(result.rows);
  }

  private async getExtensionDistribution(): Promise<AdminDashboardChartPoint[]> {
    const result = await this.db.query<DashboardLabelCountRow>(
      `SELECT coalesce(nullif(extension, ''), 'unknown') AS label,
              count(*)::int AS count
       FROM ktv_songs
       WHERE missing_at IS NULL
       GROUP BY extension
       ORDER BY count DESC, label ASC
       LIMIT 12`
    );
    return mapLabelCountRows(result.rows);
  }

  private async getLargestSongs(): Promise<AdminDashboardLargestSong[]> {
    const result = await this.db.query<DashboardLargestSongRow>(
      `SELECT s.id AS song_id,
              s.title,
              s.primary_artist_name AS artist_name,
              s.file_name,
              s.extension,
              s.size_bytes
       FROM ktv_songs s
       WHERE s.missing_at IS NULL AND s.size_bytes IS NOT NULL
       ORDER BY s.size_bytes DESC, s.title ASC
       LIMIT 8`
    );
    return result.rows.map((row) => ({
      songId: row.song_id,
      title: row.title,
      artistName: row.artist_name,
      fileName: row.file_name,
      extension: row.extension ?? "unknown",
      sizeBytes: toNumber(row.size_bytes ?? 0)
    }));
  }

  private async getDashboardTopArtists(): Promise<AdminDashboardChartPoint[]> {
    const artists = await this.listDiscoveryArtists();
    return withOtherBucket(
      artists.map((artist) => ({
        label: artist.artistName,
        value: artist.songCount
      })),
      50
    );
  }

  private async getTopStyles(): Promise<AdminDashboardChartPoint[]> {
    const rows = await this.listDiscoveryGenres();
    return withOtherBucket(
      rows.map((genre) => ({
        label: genre.genre,
        value: genre.songCount
      })),
      20
    );
  }

  private async getRequestStatusDistribution(): Promise<AdminDashboardChartPoint[]> {
    const result = await this.db.query<DashboardLabelCountRow>(
      `SELECT status AS label, count(*)::int AS count
       FROM queue_entries
       GROUP BY status
       ORDER BY count DESC, status ASC`
    );
    return mapLabelCountRows(result.rows);
  }

  private async getRequestTrend(trendRange: AdminDashboardTrendRange): Promise<AdminDashboardRequestTrendPoint[]> {
    const config = requestTrendConfigs[trendRange] ?? requestTrendConfigs["30d"];
    const result = await this.db.query<DashboardTrendRow>(
      `WITH request_trend_buckets AS (
         SELECT generate_series(
           date_trunc('${config.grain}', current_date - interval '${config.lookbackInterval}'),
           date_trunc('${config.grain}', current_date),
           interval '${config.stepInterval}'
         ) AS bucket_start
       ),
       request_trend_counts AS (
         SELECT date_trunc('${config.grain}', requested_at) AS bucket_start,
                count(*)::int AS request_count,
                count(DISTINCT coalesce(requested_by_user_phone, requested_by, requested_by_name, 'unknown'))::int AS unique_requester_count
         FROM queue_entries
         WHERE requested_at >= date_trunc('${config.grain}', current_date - interval '${config.lookbackInterval}')
         GROUP BY date_trunc('${config.grain}', requested_at)
       )
       SELECT to_char(b.bucket_start, '${config.dateFormat}') AS date,
              coalesce(c.request_count, 0)::int AS request_count,
              coalesce(c.unique_requester_count, 0)::int AS unique_requester_count
       FROM request_trend_buckets b
       LEFT JOIN request_trend_counts c ON c.bucket_start = b.bucket_start
       ORDER BY b.bucket_start ASC`
    );
    return result.rows.map((row) => ({
      date: row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date),
      requestCount: toNumber(row.request_count),
      uniqueRequesterCount: toNumber(row.unique_requester_count)
    }));
  }

  private async getTopRequestedSongs(): Promise<AdminDashboardSongRank[]> {
    const result = await this.db.query<DashboardSongRankRow>(
      `WITH top_requested_songs AS (
         SELECT q.song_id,
                count(*)::int AS request_count,
                max(q.requested_at) AS last_requested_at
         FROM queue_entries q
         GROUP BY q.song_id
         ORDER BY request_count DESC, last_requested_at DESC NULLS LAST
         LIMIT 10
       )
       SELECT t.song_id,
              coalesce(s.title, '未知歌曲') AS title,
              coalesce(s.primary_artist_name, '未知歌手') AS artist_name,
              t.request_count,
              t.last_requested_at
       FROM top_requested_songs t
       LEFT JOIN ktv_songs s ON s.id = t.song_id
       ORDER BY t.request_count DESC, t.last_requested_at DESC NULLS LAST`
    );
    return result.rows.map((row) => ({
      songId: row.song_id,
      title: row.title,
      artistName: row.artist_name,
      requestCount: toNumber(row.request_count),
      lastRequestedAt: row.last_requested_at ? toIsoString(row.last_requested_at) : null
    }));
  }

  private async getTopRequestedArtists(): Promise<AdminDashboardChartPoint[]> {
    const result = await this.db.query<DashboardLabelCountRow>(
      `WITH top_requested_artists AS (
         SELECT coalesce(s.primary_artist_name, '未知歌手') AS artist_name,
                count(*)::int AS request_count
         FROM queue_entries q
         LEFT JOIN ktv_songs s ON s.id = q.song_id
         GROUP BY coalesce(s.primary_artist_name, '未知歌手')
       )
       SELECT artist_name AS label, request_count AS count
       FROM top_requested_artists
       ORDER BY request_count DESC, artist_name ASC
       LIMIT 10`
    );
    return mapLabelCountRows(result.rows);
  }

  private async getTopRequesters(): Promise<AdminDashboardUserRank[]> {
    const result = await this.db.query<DashboardUserRankRow>(
      `WITH top_requesters AS (
         SELECT coalesce(q.requested_by_user_phone, q.requested_by, q.requested_by_name, 'unknown') AS requester_id,
                coalesce(max(u.display_name), max(q.requested_by_name), max(q.requested_by), '未知用户') AS display_name,
                count(*)::int AS request_count,
                count(DISTINCT q.song_id)::int AS unique_song_count,
                max(q.requested_at) AS last_requested_at
         FROM queue_entries q
         LEFT JOIN controller_users u ON u.phone = q.requested_by_user_phone
         GROUP BY coalesce(q.requested_by_user_phone, q.requested_by, q.requested_by_name, 'unknown')
       )
       SELECT requester_id,
              display_name,
              request_count,
              unique_song_count,
              last_requested_at
       FROM top_requesters
       ORDER BY request_count DESC, last_requested_at DESC NULLS LAST
       LIMIT 10`
    );
    return result.rows.map((row) => ({
      requesterId: row.requester_id ?? "unknown",
      displayName: row.display_name ?? "未知用户",
      requestCount: toNumber(row.request_count),
      uniqueSongCount: toNumber(row.unique_song_count),
      lastRequestedAt: row.last_requested_at ? toIsoString(row.last_requested_at) : null
    }));
  }

  private async getRecentRequests(): Promise<AdminDashboardRecentRequest[]> {
    const result = await this.db.query<DashboardRecentRequestRow>(
      `WITH recent_requests AS (
         SELECT q.id AS queue_entry_id,
                q.song_id,
                coalesce(s.title, '未知歌曲') AS title,
                coalesce(s.primary_artist_name, '未知歌手') AS artist_name,
                coalesce(u.display_name, q.requested_by_name, q.requested_by, '未知用户') AS requester_name,
                q.requested_at,
                q.status
         FROM queue_entries q
         LEFT JOIN ktv_songs s ON s.id = q.song_id
         LEFT JOIN controller_users u ON u.phone = q.requested_by_user_phone
         ORDER BY q.requested_at DESC
         LIMIT 12
       )
       SELECT *
       FROM recent_requests`
    );
    return result.rows.map((row) => ({
      queueEntryId: row.queue_entry_id,
      songId: row.song_id,
      title: row.title ?? "未知歌曲",
      artistName: row.artist_name ?? "未知歌手",
      requesterName: row.requester_name ?? "未知用户",
      requestedAt: toIsoString(row.requested_at),
      status: row.status
    }));
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

  private async getAudioCodecDistribution(): Promise<AdminDashboardChartPoint[]> {
    const result = await this.db.query<DashboardLabelCountRow>(
      `WITH track_arrays AS (
         SELECT coalesce(technical_metadata->'mediaInfoSummary'->'audioTracks', technical_metadata->'audioTracks') AS audio_tracks
         FROM ktv_songs
         WHERE missing_at IS NULL
       ),
       audio_codecs AS (
         SELECT coalesce(nullif(lower(trim(track->>'codec')), ''), 'unknown') AS label
         FROM track_arrays
         CROSS JOIN LATERAL jsonb_array_elements(audio_tracks) AS track
         WHERE jsonb_typeof(audio_tracks) = 'array'
       )
       SELECT label, count(*)::int AS count
       FROM audio_codecs
       GROUP BY label
       ORDER BY count DESC, label ASC
       LIMIT 12`
    );
    return mapLabelCountRows(result.rows);
  }

  private async getVideoCodecDistribution(): Promise<AdminDashboardChartPoint[]> {
    const result = await this.db.query<DashboardLabelCountRow>(
      `WITH video_codecs AS (
         SELECT coalesce(nullif(lower(trim(coalesce(
                  technical_metadata->'mediaInfoSummary'->>'videoCodec',
                  technical_metadata->>'videoCodec'
                ))), ''), 'unknown') AS label
         FROM ktv_songs
         WHERE missing_at IS NULL
       )
       SELECT label, count(*)::int AS count
       FROM video_codecs
       GROUP BY label
       ORDER BY count DESC, label ASC
       LIMIT 12`
    );
    return mapLabelCountRows(result.rows);
  }

  private async getVideoResolutionDistribution(): Promise<AdminDashboardChartPoint[]> {
    const result = await this.db.query<DashboardLabelCountRow>(
      `WITH resolutions AS (
         SELECT coalesce(technical_metadata->'mediaInfoSummary'->'resolution', technical_metadata->'resolution') AS resolution
         FROM ktv_songs
         WHERE missing_at IS NULL
       ),
       resolution_labels AS (
         SELECT CASE
                  WHEN jsonb_typeof(resolution) IS DISTINCT FROM 'object' THEN 'unknown'
                  WHEN nullif(resolution->>'width', '') IS NULL OR nullif(resolution->>'height', '') IS NULL THEN 'unknown'
                  ELSE concat(resolution->>'width', 'x', resolution->>'height')
                END AS label
         FROM resolutions
       )
       SELECT label, count(*)::int AS count
       FROM resolution_labels
       GROUP BY label
       ORDER BY count DESC, label ASC
       LIMIT 12`
    );
    return mapLabelCountRows(result.rows);
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

function createEmptyAdminDashboard(tables: KtvIndexTableAvailability[]): AdminDashboardResponse {
  return {
    generatedAt: new Date().toISOString(),
    metrics: [
      { id: "songs", label: "总歌曲数", value: 0, unit: "首", trendLabel: null },
      { id: "artists", label: "歌手数", value: 0, unit: "位", trendLabel: null },
      { id: "storage", label: "总存储", value: 0, unit: "bytes", trendLabel: null },
      { id: "requests", label: "累计点歌", value: 0, unit: "次", trendLabel: "近 30 天 0 次" },
      { id: "users", label: "用户数", value: 0, unit: "人", trendLabel: null },
      { id: "coverage", label: "探测覆盖", value: 0, unit: "percent", trendLabel: "待探测 0" }
    ],
    health: {
      latestRun: null,
      sourceRoot: tables.every((table) => table.exists) ? null : "索引表未就绪",
      probeCoveragePercent: 0,
      lowConfidenceCount: 0,
      missingAssetCount: 0
    },
    storage: {
      totalBytes: 0,
      sizeBuckets: [],
      extensionDistribution: [],
      largestSongs: []
    },
    catalog: {
      topArtists: [],
      topStyles: [],
      parseStrategies: [],
      technicalStatus: [],
      audioTrackDistribution: [],
      audioCodecDistribution: [],
      videoCodecDistribution: [],
      videoResolutionDistribution: []
    },
    requests: {
      totalQueueEntries: 0,
      totalSongRequests: 0,
      requestTrend: [],
      statusDistribution: [],
      topSongs: [],
      topArtists: [],
      topRequesters: [],
      recentRequests: []
    }
  };
}

function mapLabelCountRows(rows: readonly DashboardLabelCountRow[]): AdminDashboardChartPoint[] {
  return rows.map((row) => ({
    label: row.label ?? "unknown",
    value: toNumber(row.count)
  }));
}

function withOtherBucket(points: readonly AdminDashboardChartPoint[], topCount: number): AdminDashboardChartPoint[] {
  const top = points.slice(0, topCount);
  const otherValue = points.slice(topCount).reduce((sum, point) => sum + point.value, 0);
  return otherValue > 0 ? [...top, { label: "其它", value: otherValue }] : top;
}

function normalizeDashboardTrendRange(value: AdminDashboardTrendRange | undefined): AdminDashboardTrendRange {
  return value && value in requestTrendConfigs ? value : "30d";
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
