CREATE INDEX IF NOT EXISTS ktv_song_assets_active_song_idx
  ON ktv_song_assets(song_id, updated_at DESC)
  WHERE missing_at IS NULL;

