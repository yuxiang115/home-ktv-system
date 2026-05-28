CREATE TABLE IF NOT EXISTS song_cover_cache (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  source_kind text NOT NULL CHECK (source_kind IN ('formal', 'ktv-index')),
  source_song_id text NOT NULL,
  title text NOT NULL,
  artist_name text NOT NULL,
  normalized_title text NOT NULL DEFAULT '',
  normalized_artist_name text NOT NULL DEFAULT '',
  provider text,
  provider_song_id text,
  provider_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  image_url text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'found', 'not_found', 'failed')),
  confidence integer NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 100),
  error_message text,
  fetched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_kind, source_song_id)
);

CREATE INDEX IF NOT EXISTS song_cover_cache_status_idx
  ON song_cover_cache(source_kind, status, updated_at ASC);

CREATE INDEX IF NOT EXISTS song_cover_cache_lookup_idx
  ON song_cover_cache(source_kind, source_song_id)
  WHERE status = 'found' AND image_url IS NOT NULL;
