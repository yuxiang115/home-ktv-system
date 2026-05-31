ALTER TABLE ktv_songs
  ADD COLUMN IF NOT EXISTS cover_image_url text,
  ADD COLUMN IF NOT EXISTS cover_updated_at timestamptz;

DO $$
BEGIN
  IF to_regclass('public.song_cover_cache') IS NOT NULL THEN
    UPDATE ktv_songs song
    SET cover_image_url = cover.image_url,
        cover_updated_at = COALESCE(cover.fetched_at, cover.updated_at, now()),
        updated_at = now()
    FROM song_cover_cache cover
    WHERE cover.source_kind = 'nas'
      AND cover.source_song_id = song.id
      AND cover.status = 'found'
      AND cover.image_url IS NOT NULL
      AND song.cover_image_url IS NULL;
  END IF;
END $$;

DROP TABLE IF EXISTS song_cover_cache;
