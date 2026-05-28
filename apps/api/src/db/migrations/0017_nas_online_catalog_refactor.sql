CREATE TABLE IF NOT EXISTS online_songs (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  provider text NOT NULL,
  provider_song_id text NOT NULL,
  title text NOT NULL,
  normalized_title text NOT NULL,
  title_pinyin text NOT NULL DEFAULT '',
  title_initials text NOT NULL DEFAULT '',
  primary_artist_name text NOT NULL,
  normalized_primary_artist_name text NOT NULL,
  tags text[] NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider, provider_song_id)
);

CREATE TABLE IF NOT EXISTS online_song_assets (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  song_id text NOT NULL REFERENCES online_songs(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_asset_id text NOT NULL,
  media_url text NOT NULL,
  cache_path text,
  status text NOT NULL CHECK (status IN ('ready', 'caching', 'failed', 'unavailable')),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider, provider_asset_id)
);

ALTER TABLE queue_entries
  ADD COLUMN IF NOT EXISTS source_type text,
  ADD COLUMN IF NOT EXISTS nas_song_id text,
  ADD COLUMN IF NOT EXISTS nas_asset_id text,
  ADD COLUMN IF NOT EXISTS online_song_id text,
  ADD COLUMN IF NOT EXISTS online_asset_id text;

UPDATE queue_entries qe
SET source_type = 'nas',
    nas_asset_id = sr.provider_item_id,
    nas_song_id = kta.song_id
FROM source_records sr
JOIN ktv_song_assets kta
  ON kta.id = sr.provider_item_id
WHERE qe.source_type IS NULL
  AND sr.provider = 'ktv-index'
  AND sr.provider_item_id IS NOT NULL
  AND sr.asset_id = qe.asset_id;

UPDATE queue_entries qe
SET source_type = 'nas',
    nas_asset_id = regexp_replace(qe.asset_id, '^asset-ktv-', ''),
    nas_song_id = kta.song_id
FROM ktv_song_assets kta
WHERE qe.source_type IS NULL
  AND qe.asset_id LIKE 'asset-ktv-%'
  AND kta.id = regexp_replace(qe.asset_id, '^asset-ktv-', '');

CREATE TABLE IF NOT EXISTS queue_entries_unmapped_archive AS
SELECT qe.*, now() AS archived_at
FROM queue_entries qe
WHERE qe.source_type IS NULL;

UPDATE queue_entries
SET status = 'failed',
    ended_at = COALESCE(ended_at, now())
WHERE source_type IS NULL
  AND status IN ('queued', 'preparing', 'loading', 'playing');

DELETE FROM queue_entries
WHERE source_type IS NULL;

ALTER TABLE queue_entries
  ALTER COLUMN source_type SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ktv_song_assets_id_song_id_uq
  ON ktv_song_assets(id, song_id);

CREATE UNIQUE INDEX IF NOT EXISTS online_song_assets_id_song_id_uq
  ON online_song_assets(id, song_id);

ALTER TABLE queue_entries
  DROP CONSTRAINT IF EXISTS queue_entries_song_id_fkey,
  DROP CONSTRAINT IF EXISTS queue_entries_asset_id_fkey,
  DROP CONSTRAINT IF EXISTS queue_entries_source_identity_ck,
  DROP CONSTRAINT IF EXISTS queue_entries_nas_asset_song_fk,
  DROP CONSTRAINT IF EXISTS queue_entries_online_asset_song_fk;

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
  ADD CONSTRAINT queue_entries_nas_asset_song_fk
  FOREIGN KEY (nas_asset_id, nas_song_id)
  REFERENCES ktv_song_assets(id, song_id)
  ON DELETE RESTRICT;

ALTER TABLE queue_entries
  ADD CONSTRAINT queue_entries_online_asset_song_fk
  FOREIGN KEY (online_asset_id, online_song_id)
  REFERENCES online_song_assets(id, song_id)
  ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS queue_entries_nas_song_counts_idx
  ON queue_entries(source_type, nas_song_id)
  WHERE source_type = 'nas';

ALTER TABLE queue_entries DROP COLUMN IF EXISTS song_id;
ALTER TABLE queue_entries DROP COLUMN IF EXISTS asset_id;

ALTER TABLE playback_sessions
  DROP CONSTRAINT IF EXISTS playback_sessions_active_asset_id_fkey,
  DROP COLUMN IF EXISTS active_asset_id;

ALTER TABLE song_cover_cache
  DROP CONSTRAINT IF EXISTS song_cover_cache_source_kind_check;

UPDATE song_cover_cache
SET source_kind = 'nas'
WHERE source_kind = 'ktv-index';

DELETE FROM song_cover_cache
WHERE source_kind = 'formal';

ALTER TABLE song_cover_cache
  ADD CONSTRAINT song_cover_cache_source_kind_check
  CHECK (source_kind IN ('nas', 'online'));

ALTER TABLE candidate_tasks
  ADD COLUMN IF NOT EXISTS ready_source_type text CHECK (ready_source_type IN ('online')),
  ADD COLUMN IF NOT EXISTS ready_online_asset_id text REFERENCES online_song_assets(id) ON DELETE SET NULL;

ALTER TABLE candidate_tasks DROP COLUMN IF EXISTS ready_asset_id;

DROP TABLE IF EXISTS source_records;
DROP TABLE IF EXISTS import_candidate_files;
DROP TABLE IF EXISTS import_candidates;
DROP TABLE IF EXISTS import_files;
DROP TABLE IF EXISTS import_scan_runs;
DROP TABLE IF EXISTS assets;
DROP TABLE IF EXISTS songs;
