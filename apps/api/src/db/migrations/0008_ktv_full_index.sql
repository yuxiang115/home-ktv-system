CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS ktv_index_runs (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  source_root text NOT NULL,
  ssh_host text,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  files_seen integer NOT NULL DEFAULT 0 CHECK (files_seen >= 0),
  songs_upserted integer NOT NULL DEFAULT 0 CHECK (songs_upserted >= 0),
  assets_upserted integer NOT NULL DEFAULT 0 CHECK (assets_upserted >= 0),
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ktv_artists (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name text NOT NULL,
  normalized_name text NOT NULL,
  name_pinyin text NOT NULL DEFAULT '',
  name_initials text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (normalized_name)
);

CREATE TABLE IF NOT EXISTS ktv_songs (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  title text NOT NULL,
  normalized_title text NOT NULL,
  title_pinyin text NOT NULL DEFAULT '',
  title_initials text NOT NULL DEFAULT '',
  primary_artist_name text NOT NULL,
  normalized_primary_artist_name text NOT NULL,
  category text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (normalized_title, normalized_primary_artist_name, category)
);

CREATE TABLE IF NOT EXISTS ktv_song_artists (
  song_id text NOT NULL REFERENCES ktv_songs(id) ON DELETE CASCADE,
  artist_id text NOT NULL REFERENCES ktv_artists(id) ON DELETE CASCADE,
  artist_order integer NOT NULL DEFAULT 0 CHECK (artist_order >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (song_id, artist_id)
);

CREATE TABLE IF NOT EXISTS ktv_song_assets (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  song_id text NOT NULL REFERENCES ktv_songs(id) ON DELETE CASCADE,
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
  first_seen_run_id text REFERENCES ktv_index_runs(id) ON DELETE SET NULL,
  last_seen_run_id text REFERENCES ktv_index_runs(id) ON DELETE SET NULL,
  missing_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (file_path)
);

CREATE INDEX IF NOT EXISTS ktv_index_runs_status_idx
  ON ktv_index_runs(status, started_at DESC);

CREATE INDEX IF NOT EXISTS ktv_artists_normalized_name_trgm_idx
  ON ktv_artists USING gin (normalized_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS ktv_artists_name_pinyin_trgm_idx
  ON ktv_artists USING gin (name_pinyin gin_trgm_ops);

CREATE INDEX IF NOT EXISTS ktv_songs_normalized_title_trgm_idx
  ON ktv_songs USING gin (normalized_title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS ktv_songs_title_pinyin_trgm_idx
  ON ktv_songs USING gin (title_pinyin gin_trgm_ops);

CREATE INDEX IF NOT EXISTS ktv_songs_title_initials_idx
  ON ktv_songs(title_initials);

CREATE INDEX IF NOT EXISTS ktv_songs_category_idx
  ON ktv_songs(category);

CREATE INDEX IF NOT EXISTS ktv_songs_primary_artist_idx
  ON ktv_songs(normalized_primary_artist_name);

CREATE INDEX IF NOT EXISTS ktv_song_artists_artist_idx
  ON ktv_song_artists(artist_id, song_id);

CREATE UNIQUE INDEX IF NOT EXISTS ktv_song_assets_path_uq
  ON ktv_song_assets(file_path);

CREATE INDEX IF NOT EXISTS ktv_song_assets_song_idx
  ON ktv_song_assets(song_id);

CREATE INDEX IF NOT EXISTS ktv_song_assets_technical_status_idx
  ON ktv_song_assets(technical_status, updated_at DESC);
