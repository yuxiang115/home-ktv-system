import type { QueryExecutor } from "../../db/query-executor.js";
import {
  songCoverKey,
  type SongCoverBackfillCandidate,
  type SongCoverEntry,
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
}

export interface SongCoverRepository {
  findBySongKeys(keys: readonly SongCoverLookupKey[]): Promise<Map<string, SongCoverEntry>>;
  listCoverCandidates(input: ListCoverCandidatesInput): Promise<SongCoverBackfillCandidate[]>;
  upsertCoverResult(input: UpsertCoverResultInput): Promise<void>;
}

interface CoverRow {
  source_kind: SongCoverSource;
  source_song_id: string;
  cover_image_url: string | null;
}

interface CoverCandidateRow {
  source_kind: SongCoverSource;
  source_song_id: string;
  title: string;
  artist_name: string;
}

export class PgSongCoverRepository implements SongCoverRepository {
  constructor(private readonly db: QueryExecutor) {}

  async findBySongKeys(keys: readonly SongCoverLookupKey[]): Promise<Map<string, SongCoverEntry>> {
    if (keys.length === 0) {
      return new Map();
    }

    const result = await this.db.query<CoverRow>(
      `WITH requested AS (
         SELECT *
         FROM unnest($1::text[], $2::text[]) AS request(source_kind, source_song_id)
       )
       SELECT 'nas'::text AS source_kind,
              s.id AS source_song_id,
              s.cover_image_url
       FROM ktv_songs s
       JOIN requested r
         ON r.source_kind = 'nas'
        AND r.source_song_id = s.id
       WHERE s.cover_image_url IS NOT NULL`,
      [keys.map((key) => key.source), keys.map((key) => key.sourceSongId)]
    );

    return new Map(
      result.rows
        .filter((row) => row.cover_image_url)
        .map((row) => {
          const entry: SongCoverEntry = {
            source: row.source_kind,
            sourceSongId: row.source_song_id,
            imageUrl: row.cover_image_url!
          };
          return [songCoverKey(entry), entry];
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
      `UPDATE ktv_songs
       SET cover_image_url = CASE
             WHEN $3::text = 'found' THEN $4
             ELSE cover_image_url
           END,
           cover_updated_at = now(),
           updated_at = now()
       WHERE id = $2
         AND $1::text = 'nas'`,
      [
        input.source,
        input.sourceSongId,
        input.status,
        input.imageUrl ?? null
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
       WHERE s.missing_at IS NULL
         AND (
           s.cover_image_url IS NULL
           AND ($2::boolean = true OR s.cover_updated_at IS NULL)
         )
       ORDER BY s.cover_updated_at ASC NULLS FIRST, s.updated_at DESC, s.title ASC, s.primary_artist_name ASC
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
              AND column_name IN ('file_path', 'artist_names', 'style_tags', 'cover_image_url', 'cover_updated_at')
            GROUP BY table_name
            HAVING count(*) = 5
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
