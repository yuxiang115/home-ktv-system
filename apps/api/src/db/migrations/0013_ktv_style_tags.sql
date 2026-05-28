CREATE TEMP TABLE ktv_song_merge_map ON COMMIT DROP AS
SELECT id AS old_song_id,
       first_value(id) OVER (
         PARTITION BY normalized_title, normalized_primary_artist_name
         ORDER BY updated_at DESC, created_at ASC, id ASC
       ) AS keep_song_id
FROM ktv_songs;

INSERT INTO ktv_song_artists (song_id, artist_id, artist_order, created_at)
SELECT map.keep_song_id,
       source.artist_id,
       min(source.artist_order) AS artist_order,
       min(source.created_at) AS created_at
FROM ktv_song_artists source
JOIN ktv_song_merge_map map ON map.old_song_id = source.song_id
WHERE map.old_song_id <> map.keep_song_id
GROUP BY map.keep_song_id, source.artist_id
ON CONFLICT (song_id, artist_id)
DO UPDATE SET artist_order = LEAST(ktv_song_artists.artist_order, EXCLUDED.artist_order);

UPDATE ktv_song_assets asset
SET song_id = map.keep_song_id,
    updated_at = now()
FROM ktv_song_merge_map map
WHERE asset.song_id = map.old_song_id
  AND map.old_song_id <> map.keep_song_id;

DELETE FROM ktv_songs song
USING ktv_song_merge_map map
WHERE song.id = map.old_song_id
  AND map.old_song_id <> map.keep_song_id;

DROP INDEX IF EXISTS ktv_songs_category_idx;
ALTER TABLE ktv_songs DROP COLUMN IF EXISTS category;

CREATE UNIQUE INDEX IF NOT EXISTS ktv_songs_normalized_title_artist_uq
  ON ktv_songs(normalized_title, normalized_primary_artist_name);

CREATE TABLE IF NOT EXISTS ktv_style_groups (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name text NOT NULL UNIQUE,
  sort_order integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ktv_style_tags (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  group_id text NOT NULL REFERENCES ktv_style_groups(id) ON DELETE RESTRICT,
  name text NOT NULL,
  normalized_name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (normalized_name)
);

CREATE TABLE IF NOT EXISTS ktv_song_style_tags (
  song_id text NOT NULL REFERENCES ktv_songs(id) ON DELETE CASCADE,
  tag_id text NOT NULL REFERENCES ktv_style_tags(id) ON DELETE CASCADE,
  source text NOT NULL,
  confidence numeric(4,3) NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  locked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (song_id, tag_id, source)
);

CREATE TABLE IF NOT EXISTS ktv_song_tagging_runs (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  source text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  selected_count integer NOT NULL DEFAULT 0 CHECK (selected_count >= 0),
  processed_count integer NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
  tagged_count integer NOT NULL DEFAULT 0 CHECK (tagged_count >= 0),
  empty_count integer NOT NULL DEFAULT 0 CHECK (empty_count >= 0),
  failed_count integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  average_tags numeric(8,3),
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ktv_song_tagging_status (
  song_id text PRIMARY KEY REFERENCES ktv_songs(id) ON DELETE CASCADE,
  source text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'tagged', 'empty', 'failed')),
  tag_count integer NOT NULL DEFAULT 0 CHECK (tag_count >= 0),
  confidence numeric(4,3),
  run_id text REFERENCES ktv_song_tagging_runs(id) ON DELETE SET NULL,
  error_message text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ktv_style_tags_group_idx
  ON ktv_style_tags(group_id, sort_order, name);

CREATE INDEX IF NOT EXISTS ktv_song_style_tags_tag_idx
  ON ktv_song_style_tags(tag_id, song_id);

CREATE INDEX IF NOT EXISTS ktv_song_style_tags_source_idx
  ON ktv_song_style_tags(source, updated_at DESC);

CREATE INDEX IF NOT EXISTS ktv_song_tagging_runs_source_started_idx
  ON ktv_song_tagging_runs(source, started_at DESC);

CREATE INDEX IF NOT EXISTS ktv_song_tagging_status_source_status_idx
  ON ktv_song_tagging_status(source, status, updated_at DESC);
