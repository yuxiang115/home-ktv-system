ALTER TABLE queue_entries
  DROP CONSTRAINT IF EXISTS queue_entries_nas_song_fk,
  DROP CONSTRAINT IF EXISTS queue_entries_nas_identity_ck,
  DROP CONSTRAINT IF EXISTS queue_entries_source_identity_ck;

ALTER TABLE queue_entries
  ADD COLUMN IF NOT EXISTS song_id text;

UPDATE queue_entries
SET song_id = COALESCE(nas_song_id, nas_asset_id, song_id)
WHERE song_id IS NULL
  AND COALESCE(source_type, 'nas') = 'nas';

DELETE FROM queue_entries
WHERE song_id IS NULL
   OR COALESCE(source_type, 'nas') <> 'nas';

ALTER TABLE queue_entries
  ALTER COLUMN song_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'queue_entries_song_fk'
  ) THEN
    ALTER TABLE queue_entries
      ADD CONSTRAINT queue_entries_song_fk
      FOREIGN KEY (song_id) REFERENCES ktv_songs(id) ON DELETE RESTRICT;
  END IF;
END $$;

ALTER TABLE queue_entries
  DROP COLUMN IF EXISTS source_type,
  DROP COLUMN IF EXISTS nas_song_id,
  DROP COLUMN IF EXISTS nas_asset_id,
  DROP COLUMN IF EXISTS online_song_id,
  DROP COLUMN IF EXISTS online_asset_id;

DROP INDEX IF EXISTS candidate_tasks_room_status_updated_idx;
DROP INDEX IF EXISTS candidate_tasks_provider_candidate_idx;
DROP INDEX IF EXISTS candidate_tasks_room_recent_idx;
DROP TABLE IF EXISTS candidate_tasks;
