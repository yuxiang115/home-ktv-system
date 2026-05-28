CREATE TABLE IF NOT EXISTS ktv_song_tagging_cache (
  source text NOT NULL,
  cache_key text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, cache_key)
);

CREATE INDEX IF NOT EXISTS ktv_song_tagging_cache_updated_idx
  ON ktv_song_tagging_cache(source, updated_at DESC);
