import type { QueryExecutor } from "../../db/query-executor.js";
import {
  songCoverCacheKey,
  type SongCoverBackfillCandidate,
  type SongCoverCacheEntry,
  type SongCoverLookupKey,
  type SongCoverSource,
  type SongCoverStatus
} from "./types.js";

export interface ListCoverCandidatesInput {
  limit: number;
  source?: SongCoverSource;
  retryFailed?: boolean;
}

export interface UpsertCoverResultInput extends SongCoverBackfillCandidate {
  status: SongCoverStatus;
  imageUrl?: string | null;
  provider?: string | null;
  providerSongId?: string | null;
  confidence?: number;
  errorMessage?: string | null;
  providerPayload?: Record<string, unknown>;
}

export interface SongCoverCacheRepository {
  findBySongKeys(keys: readonly SongCoverLookupKey[]): Promise<Map<string, SongCoverCacheEntry>>;
  listCoverCandidates(input: ListCoverCandidatesInput): Promise<SongCoverBackfillCandidate[]>;
  upsertCoverResult(input: UpsertCoverResultInput): Promise<void>;
}

interface CoverCacheRow {
  source_kind: SongCoverSource;
  source_song_id: string;
  image_url: string | null;
  provider: string | null;
  provider_song_id: string | null;
  confidence: number | string;
}

interface CoverCandidateRow {
  source_kind: SongCoverSource;
  source_song_id: string;
  title: string;
  artist_name: string;
}

export class PgSongCoverCacheRepository implements SongCoverCacheRepository {
  constructor(private readonly db: QueryExecutor) {}

  async findBySongKeys(keys: readonly SongCoverLookupKey[]): Promise<Map<string, SongCoverCacheEntry>> {
    if (keys.length === 0) {
      return new Map();
    }

    const result = await this.db.query<CoverCacheRow>(
      `WITH requested AS (
         SELECT *
         FROM unnest($1::text[], $2::text[]) AS request(source_kind, source_song_id)
       )
       SELECT c.source_kind, c.source_song_id, c.image_url, c.provider, c.provider_song_id, c.confidence
       FROM song_cover_cache c
       JOIN requested r
         ON r.source_kind = c.source_kind
        AND r.source_song_id = c.source_song_id
       WHERE c.status = 'found'
         AND c.image_url IS NOT NULL`,
      [keys.map((key) => key.source), keys.map((key) => key.sourceSongId)]
    );

    return new Map(
      result.rows
        .filter((row) => row.image_url && row.provider)
        .map((row) => {
          const entry: SongCoverCacheEntry = {
            source: row.source_kind,
            sourceSongId: row.source_song_id,
            imageUrl: row.image_url!,
            provider: row.provider!,
            providerSongId: row.provider_song_id,
            confidence: toNumber(row.confidence)
          };
          return [songCoverCacheKey(entry), entry];
        })
    );
  }

  async listCoverCandidates(input: ListCoverCandidatesInput): Promise<SongCoverBackfillCandidate[]> {
    const limit = Math.min(2000, Math.max(1, Math.trunc(input.limit)));
    const candidates: SongCoverBackfillCandidate[] = [];

    if (!input.source || input.source === "nas") {
      if (await this.hasKtvIndexTables()) {
        candidates.push(...(await this.listNasCandidates({ ...input, limit })));
      }
    }

    return candidates.slice(0, limit);
  }

  async upsertCoverResult(input: UpsertCoverResultInput): Promise<void> {
    await this.db.query(
      `INSERT INTO song_cover_cache (
         source_kind,
         source_song_id,
         title,
         artist_name,
         normalized_title,
         normalized_artist_name,
         provider,
         provider_song_id,
         provider_payload,
         image_url,
         status,
         confidence,
         error_message,
         fetched_at
       )
       VALUES ($1, $2, $3, $4, lower($3), lower($4), $5, $6, $7::jsonb, $8, $9, $10, $11, now())
       ON CONFLICT (source_kind, source_song_id)
       DO UPDATE SET
         title = EXCLUDED.title,
         artist_name = EXCLUDED.artist_name,
         normalized_title = EXCLUDED.normalized_title,
         normalized_artist_name = EXCLUDED.normalized_artist_name,
         provider = EXCLUDED.provider,
         provider_song_id = EXCLUDED.provider_song_id,
         provider_payload = EXCLUDED.provider_payload,
         image_url = EXCLUDED.image_url,
         status = EXCLUDED.status,
         confidence = EXCLUDED.confidence,
         error_message = EXCLUDED.error_message,
         fetched_at = EXCLUDED.fetched_at,
         updated_at = now()`,
      [
        input.source,
        input.sourceSongId,
        input.title,
        input.artistName,
        input.provider ?? null,
        input.providerSongId ?? null,
        JSON.stringify(input.providerPayload ?? {}),
        input.imageUrl ?? null,
        input.status,
        input.confidence ?? 0,
        input.errorMessage ?? null
      ]
    );
  }

  private async listNasCandidates(input: Required<Pick<ListCoverCandidatesInput, "limit">> & ListCoverCandidatesInput) {
    const result = await this.db.query<CoverCandidateRow>(
      `SELECT 'nas'::text AS source_kind,
              s.id AS source_song_id,
              s.title,
              s.primary_artist_name AS artist_name
       FROM ktv_songs s
       LEFT JOIN song_cover_cache c
         ON c.source_kind = 'nas'
        AND c.source_song_id = s.id
       WHERE s.missing_at IS NULL
         AND (
           c.source_song_id IS NULL
           OR c.status = 'pending'
           OR ($2::boolean = true AND c.status = 'failed')
         )
       ORDER BY c.updated_at ASC NULLS FIRST, s.updated_at DESC, s.title ASC, s.primary_artist_name ASC
       LIMIT $1`,
      [input.limit, input.retryFailed === true]
    );
    return result.rows.map(mapCandidateRow);
  }

  private async hasKtvIndexTables(): Promise<boolean> {
    const result = await this.db.query<{ exists: boolean }>(
      `SELECT to_regclass('public.ktv_songs') IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'ktv_songs'
              AND column_name IN ('file_path', 'artist_names', 'style_tags')
            GROUP BY table_name
            HAVING count(*) = 3
          ) AS exists`
    );
    return result.rows[0]?.exists === true;
  }
}

function mapCandidateRow(row: CoverCandidateRow): SongCoverBackfillCandidate {
  return {
    source: row.source_kind,
    sourceSongId: row.source_song_id,
    title: row.title,
    artistName: row.artist_name
  };
}

function toNumber(value: number | string): number {
  return typeof value === "number" ? value : Number.parseInt(value, 10);
}
