ALTER TABLE queue_entries
  DROP CONSTRAINT IF EXISTS queue_entries_nas_asset_song_fk,
  DROP CONSTRAINT IF EXISTS queue_entries_online_asset_song_fk,
  DROP CONSTRAINT IF EXISTS queue_entries_nas_song_fk,
  DROP CONSTRAINT IF EXISTS queue_entries_nas_identity_ck,
  DROP CONSTRAINT IF EXISTS queue_entries_source_identity_ck;

ALTER TABLE candidate_tasks
  DROP CONSTRAINT IF EXISTS candidate_tasks_ready_online_asset_id_fkey,
  ADD COLUMN IF NOT EXISTS ready_asset_id text,
  ADD COLUMN IF NOT EXISTS ready_media_url text,
  ADD COLUMN IF NOT EXISTS ready_cache_path text,
  ADD COLUMN IF NOT EXISTS ready_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE candidate_tasks
SET ready_asset_id = COALESCE(ready_asset_id, ready_online_asset_id)
WHERE ready_online_asset_id IS NOT NULL;

ALTER TABLE candidate_tasks
  DROP COLUMN IF EXISTS ready_source_type,
  DROP COLUMN IF EXISTS ready_online_asset_id;

CREATE TABLE ktv_songs_minimal (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  title text NOT NULL,
  normalized_title text NOT NULL,
  title_pinyin text NOT NULL DEFAULT '',
  title_initials text NOT NULL DEFAULT '',
  primary_artist_name text NOT NULL,
  normalized_primary_artist_name text NOT NULL,
  artist_names text[] NOT NULL DEFAULT '{}',
  style_tags text[] NOT NULL DEFAULT '{}',
  file_path text NOT NULL,
  relative_path text NOT NULL,
  file_name text NOT NULL,
  extension text NOT NULL,
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  mtime_ms bigint CHECK (mtime_ms IS NULL OR mtime_ms >= 0),
  parse_strategy text NOT NULL CHECK (parse_strategy IN ('filename', 'path', 'hybrid', 'fallback')),
  parse_confidence numeric(4,3) NOT NULL CHECK (parse_confidence >= 0 AND parse_confidence <= 1),
  technical_status text NOT NULL DEFAULT 'pending' CHECK (technical_status IN ('pending', 'probed', 'failed')),
  technical_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_root text NOT NULL DEFAULT '',
  ssh_host text,
  first_seen_run_id text,
  last_seen_run_id text,
  missing_at timestamptz,
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  last_requested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ktv_songs_minimal (
  id,
  title,
  normalized_title,
  title_pinyin,
  title_initials,
  primary_artist_name,
  normalized_primary_artist_name,
  artist_names,
  style_tags,
  file_path,
  relative_path,
  file_name,
  extension,
  size_bytes,
  mtime_ms,
  parse_strategy,
  parse_confidence,
  technical_status,
  technical_metadata,
  source_root,
  ssh_host,
  first_seen_run_id,
  last_seen_run_id,
  missing_at,
  request_count,
  last_requested_at,
  created_at,
  updated_at
)
SELECT asset.id,
       song.title,
       song.normalized_title,
       song.title_pinyin,
       song.title_initials,
       song.primary_artist_name,
       song.normalized_primary_artist_name,
       COALESCE(artists.artist_names, ARRAY[song.primary_artist_name]::text[]),
       COALESCE(tags.style_tags, ARRAY[]::text[]),
       asset.file_path,
       asset.relative_path,
       asset.file_name,
       asset.extension,
       asset.size_bytes,
       asset.mtime_ms,
       asset.parse_strategy,
       asset.parse_confidence,
       asset.technical_status,
       asset.technical_metadata,
       COALESCE(last_run.source_root, first_run.source_root, ''),
       COALESCE(last_run.ssh_host, first_run.ssh_host),
       asset.first_seen_run_id,
       asset.last_seen_run_id,
       asset.missing_at,
       song.request_count,
       song.last_requested_at,
       LEAST(song.created_at, asset.created_at),
       GREATEST(song.updated_at, asset.updated_at)
FROM ktv_song_assets asset
JOIN ktv_songs song ON song.id = asset.song_id
LEFT JOIN ktv_index_runs first_run ON first_run.id = asset.first_seen_run_id
LEFT JOIN ktv_index_runs last_run ON last_run.id = asset.last_seen_run_id
LEFT JOIN LATERAL (
  SELECT array_agg(artist.name ORDER BY song_artist.artist_order, artist.name) AS artist_names
  FROM ktv_song_artists song_artist
  JOIN ktv_artists artist ON artist.id = song_artist.artist_id
  WHERE song_artist.song_id = song.id
) artists ON true
LEFT JOIN LATERAL (
  SELECT array_agg(DISTINCT style_tag.tag_name ORDER BY style_tag.tag_name) AS style_tags
  FROM ktv_song_style_tags style_tag
  WHERE style_tag.song_id = song.id
    AND length(trim(style_tag.tag_name)) > 0
) tags ON true;

WITH copied_covers AS (
  INSERT INTO song_cover_cache (
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
    fetched_at,
    created_at,
    updated_at
  )
  SELECT cover.source_kind,
         asset.id AS source_song_id,
         cover.title,
         cover.artist_name,
         cover.normalized_title,
         cover.normalized_artist_name,
         cover.provider,
         cover.provider_song_id,
         cover.provider_payload,
         cover.image_url,
         cover.status,
         cover.confidence,
         cover.error_message,
         cover.fetched_at,
         cover.created_at,
         cover.updated_at
  FROM song_cover_cache cover
  JOIN ktv_song_assets asset ON asset.song_id = cover.source_song_id
  WHERE cover.source_kind = 'nas'
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
    updated_at = EXCLUDED.updated_at
  RETURNING 1
)
DELETE FROM song_cover_cache cover
WHERE cover.source_kind = 'nas'
  AND EXISTS (
    SELECT 1
    FROM ktv_songs song
    WHERE song.id = cover.source_song_id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM ktv_song_assets asset
    WHERE asset.id = cover.source_song_id
  );

UPDATE queue_entries
SET nas_song_id = nas_asset_id
WHERE source_type = 'nas'
  AND nas_asset_id IS NOT NULL;

DROP TABLE IF EXISTS ktv_song_style_tags;
DROP TABLE IF EXISTS ktv_song_artists;
DROP TABLE IF EXISTS ktv_artists;
DROP TABLE IF EXISTS ktv_song_assets;
DROP TABLE IF EXISTS ktv_index_runs;
DROP TABLE IF EXISTS online_song_assets;
DROP TABLE IF EXISTS online_songs;

ALTER TABLE ktv_songs RENAME TO ktv_songs_legacy;
ALTER TABLE ktv_songs_minimal RENAME TO ktv_songs;
DROP TABLE IF EXISTS ktv_songs_legacy;
ALTER INDEX IF EXISTS ktv_songs_minimal_pkey RENAME TO ktv_songs_pkey;

CREATE UNIQUE INDEX IF NOT EXISTS ktv_songs_file_path_uq
  ON ktv_songs(file_path);
CREATE INDEX IF NOT EXISTS ktv_songs_normalized_title_trgm_idx
  ON ktv_songs USING gin (normalized_title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ktv_songs_title_pinyin_trgm_idx
  ON ktv_songs USING gin (title_pinyin gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ktv_songs_title_initials_idx
  ON ktv_songs(title_initials);
CREATE INDEX IF NOT EXISTS ktv_songs_primary_artist_idx
  ON ktv_songs(normalized_primary_artist_name);
CREATE INDEX IF NOT EXISTS ktv_songs_artist_names_gin_idx
  ON ktv_songs USING gin (artist_names);
CREATE INDEX IF NOT EXISTS ktv_songs_style_tags_gin_idx
  ON ktv_songs USING gin (style_tags);
CREATE INDEX IF NOT EXISTS ktv_songs_request_count_idx
  ON ktv_songs(request_count DESC, last_requested_at DESC)
  WHERE request_count > 0;
CREATE INDEX IF NOT EXISTS ktv_songs_technical_status_idx
  ON ktv_songs(technical_status, updated_at DESC);
CREATE INDEX IF NOT EXISTS ktv_songs_active_idx
  ON ktv_songs(updated_at DESC, file_path ASC)
  WHERE missing_at IS NULL;

ALTER TABLE queue_entries
  ADD CONSTRAINT queue_entries_source_identity_ck
  CHECK (
    (
      source_type = 'nas'
      AND nas_song_id IS NOT NULL
      AND nas_asset_id IS NOT NULL
      AND online_song_id IS NULL
      AND online_asset_id IS NULL
    )
    OR
    (
      source_type = 'online'
      AND online_song_id IS NOT NULL
      AND online_asset_id IS NOT NULL
      AND nas_song_id IS NULL
      AND nas_asset_id IS NULL
    )
  );

ALTER TABLE queue_entries
  ADD CONSTRAINT queue_entries_nas_identity_ck
  CHECK (source_type <> 'nas' OR nas_song_id = nas_asset_id);

ALTER TABLE queue_entries
  ADD CONSTRAINT queue_entries_nas_song_fk
  FOREIGN KEY (nas_song_id) REFERENCES ktv_songs(id)
  ON DELETE RESTRICT;
