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
import { normalizeSearchText } from "../catalog/search-normalization.js";

export interface SearchKtvIndexedSongsInput {
  query: string;
  limit?: number;
  versionsPerSong?: number;
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
  category: string;
  match_reason: SongSearchMatchReason | "category";
  score: number | string;
  asset_id: string;
  file_name: string;
  file_path: string;
  extension: string;
  size_bytes: number | string | null;
  parse_confidence: number | string;
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

export class PgKtvIndexReadRepository implements KtvIndexReadRepository {
  constructor(private readonly db: QueryExecutor) {}

  async searchIndexedSongs(input: SearchKtvIndexedSongsInput): Promise<SongSearchIndexedResult[]> {
    const rows = await this.queryIndexedRows(input);
    return mapIndexedSearchRows(rows);
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
        lowConfidenceCount: 0,
        minParseConfidence: null,
        nasSample: emptyNasSample,
        preview: []
      };
    }

    const [latestRun, counts, parseStrategies, confidence, preview] = await Promise.all([
      this.getLatestRun(),
      this.getCounts(),
      this.getParseStrategies(),
      this.getConfidenceSummary(),
      this.searchDiagnosticsPreview({
        query: input.previewQuery ?? "",
        limit: input.previewLimit ?? 8,
        versionsPerSong: 4
      })
    ]);

    return {
      tables,
      latestRun,
      sourceRoot: latestRun?.sourceRoot ?? null,
      activeAssetCount: counts.activeAssetCount,
      missingAssetCount: counts.missingAssetCount,
      songCount: counts.songCount,
      artistCount: counts.artistCount,
      parseStrategies,
      lowConfidenceCount: confidence.lowConfidenceCount,
      minParseConfidence: confidence.minParseConfidence,
      nasSample: emptyNasSample,
      preview
    };
  }

  private async queryIndexedRows(input: SearchKtvIndexedSongsInput): Promise<IndexedSearchRow[]> {
    const normalizedQuery = normalizeSearchText(input.query);
    const likeQuery = `%${normalizedQuery}%`;
    const categoryQuery = `%${input.query.trim()}%`;
    const limit = Math.min(30, Math.max(1, input.limit ?? 20));
    const versionsPerSong = Math.min(8, Math.max(1, input.versionsPerSong ?? 4));

    const result = await this.db.query<IndexedSearchRow>(
      `WITH matched_songs AS (
         SELECT s.id AS song_id,
                s.title,
                s.primary_artist_name,
                s.category,
                CASE
                  WHEN $1 = '' THEN 1
                  WHEN s.normalized_title = $1 THEN 100
                  WHEN s.normalized_primary_artist_name = $1 THEN 90
                  WHEN bool_or(ar.normalized_name = $1) THEN 85
                  WHEN s.normalized_title LIKE $2 OR similarity(s.normalized_title, $1) > 0.25 THEN 70
                  WHEN s.normalized_primary_artist_name LIKE $2 OR bool_or(ar.normalized_name LIKE $2) THEN 60
                  WHEN s.title_pinyin LIKE $2 OR bool_or(ar.name_pinyin LIKE $2) THEN 50
                  WHEN s.title_initials LIKE $2 OR bool_or(ar.name_initials LIKE $2) THEN 45
                  WHEN s.category ILIKE $3 THEN 35
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
                  WHEN s.category ILIKE $3 THEN 'category'
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
            OR s.category ILIKE $3
         GROUP BY s.id, s.title, s.primary_artist_name, s.category, s.normalized_title,
                  s.normalized_primary_artist_name, s.title_pinyin, s.title_initials
         ORDER BY score DESC, s.title ASC, s.primary_artist_name ASC, s.category ASC
         LIMIT $4
       ),
       ranked_assets AS (
         SELECT ms.song_id,
                ms.title,
                ms.primary_artist_name,
                ms.category AS song_category,
                ms.match_reason,
                ms.score,
                a.id AS asset_id,
                a.file_name,
                a.file_path,
                a.extension,
                a.size_bytes,
                a.parse_confidence,
                a.missing_at,
                ms.song_category AS asset_category,
                row_number() OVER (PARTITION BY ms.song_id ORDER BY a.updated_at DESC, a.file_path ASC) AS asset_rank
         FROM matched_songs ms
         JOIN ktv_song_assets a ON a.song_id = ms.song_id
         WHERE a.missing_at IS NULL
       )
       SELECT song_id,
              title,
              primary_artist_name,
              asset_category AS category,
              match_reason,
              score,
              asset_id,
              file_name,
              file_path,
              extension,
              size_bytes,
              parse_confidence,
              missing_at
       FROM ranked_assets
       WHERE asset_rank <= $5
       ORDER BY score DESC, title ASC, primary_artist_name ASC, category ASC, file_name ASC`,
      [normalizedQuery, likeQuery, categoryQuery, limit, versionsPerSong]
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
}

function mapIndexedSearchRows(rows: readonly IndexedSearchRow[]): SongSearchIndexedResult[] {
  return mapGroupedRows(rows, (row): SongSearchIndexedVersionOption => ({
    indexedAssetId: row.asset_id,
    displayName: row.file_name,
    sourceLabel: "KTV索引",
    extension: row.extension,
    sizeBytes: toNullableNumber(row.size_bytes),
    category: row.category,
    queueState: "needs_catalog_sync",
    canQueue: false,
    disabledLabel: "需同步入库后可点歌"
  }));
}

function mapDiagnosticsPreviewRows(rows: readonly IndexedSearchRow[]): KtvIndexDiagnosticsPreviewResult[] {
  return mapGroupedRows(rows, (row) => ({
    indexedAssetId: row.asset_id,
    displayName: row.file_name,
    sourceLabel: "KTV索引",
    extension: row.extension,
    sizeBytes: toNullableNumber(row.size_bytes),
    category: row.category,
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
      category: first.category,
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
