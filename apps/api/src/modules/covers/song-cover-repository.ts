import type { QueryExecutor } from "../../db/query-executor.js";
import {
  songCoverKey,
  type SongCoverEntry,
  type SongCoverLookupKey,
  type SongCoverSource
} from "./types.js";

export interface SongCoverRepository {
  findBySongKeys(keys: readonly SongCoverLookupKey[]): Promise<Map<string, SongCoverEntry>>;
}

interface CoverRow {
  source_kind: SongCoverSource;
  source_song_id: string;
  cover_image_url: string | null;
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
          const thumbnailImageUrl = deriveLocalNasThumbnailUrl(row.cover_image_url!);
          const entry: SongCoverEntry = {
            source: row.source_kind,
            sourceSongId: row.source_song_id,
            imageUrl: row.cover_image_url!,
            ...(thumbnailImageUrl ? { thumbnailImageUrl } : {})
          };
          return [songCoverKey(entry), entry];
        })
    );
  }
}

function deriveLocalNasThumbnailUrl(imageUrl: string): string | null {
  const marker = "/media/covers/nas/";
  const index = imageUrl.lastIndexOf(marker);
  if (index < 0 || !imageUrl.endsWith(".jpg")) {
    return null;
  }
  const fileName = imageUrl.slice(index + marker.length);
  if (fileName.includes("/")) {
    return null;
  }
  return `${imageUrl.slice(0, index)}${marker}thumbs/${fileName}`;
}
