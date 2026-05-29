-- 0019_runtime_db_simplification

ALTER TABLE ktv_songs
  ADD COLUMN IF NOT EXISTS request_count integer,
  ADD COLUMN IF NOT EXISTS last_requested_at timestamptz;

UPDATE ktv_songs
SET request_count = 0
WHERE request_count IS NULL;

ALTER TABLE ktv_songs
  ALTER COLUMN request_count SET DEFAULT 0,
  ALTER COLUMN request_count SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ktv_songs_request_count_nonnegative_ck'
  ) THEN
    ALTER TABLE ktv_songs
      ADD CONSTRAINT ktv_songs_request_count_nonnegative_ck CHECK (request_count >= 0);
  END IF;
END $$;

WITH counts AS (
  SELECT nas_song_id AS song_id,
         COUNT(*)::integer AS request_count,
         MAX(requested_at) AS last_requested_at
  FROM queue_entries
  WHERE source_type = 'nas'
    AND nas_song_id IS NOT NULL
  GROUP BY nas_song_id
)
UPDATE ktv_songs
SET request_count = counts.request_count,
    last_requested_at = counts.last_requested_at,
    updated_at = now()
FROM counts
WHERE ktv_songs.id = counts.song_id;

ALTER TABLE rooms
  DROP CONSTRAINT IF EXISTS rooms_default_player_device_fk;

ALTER TABLE queue_entries
  DROP CONSTRAINT IF EXISTS queue_entries_removed_by_control_session_fk;

ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS pairing_token_value text,
  ADD COLUMN IF NOT EXISTS pairing_token_hash text,
  ADD COLUMN IF NOT EXISTS pairing_token_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS pairing_token_rotated_at timestamptz,
  ADD COLUMN IF NOT EXISTS current_queue_entry_id text,
  ADD COLUMN IF NOT EXISTS target_vocal_mode text,
  ADD COLUMN IF NOT EXISTS player_state text,
  ADD COLUMN IF NOT EXISTS player_position_ms integer,
  ADD COLUMN IF NOT EXISTS next_queue_entry_id text,
  ADD COLUMN IF NOT EXISTS playback_version integer,
  ADD COLUMN IF NOT EXISTS volume_percent integer,
  ADD COLUMN IF NOT EXISTS media_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS playback_updated_at timestamptz;

UPDATE rooms AS r
SET pairing_token_value = rpt.token_value,
    pairing_token_hash = rpt.token_hash,
    pairing_token_expires_at = rpt.token_expires_at,
    pairing_token_rotated_at = rpt.rotated_at,
    updated_at = now()
FROM room_pairing_tokens AS rpt
WHERE rpt.room_id = r.id;

UPDATE rooms AS r
SET target_vocal_mode = COALESCE(ps.target_vocal_mode, 'instrumental'),
    volume_percent = COALESCE(ps.volume_percent, 50),
    playback_version = COALESCE(ps.version, 1),
    playback_updated_at = now()
FROM playback_sessions AS ps
WHERE ps.room_id = r.id;

UPDATE rooms
SET default_player_device_id = NULL,
    current_queue_entry_id = NULL,
    player_state = 'idle',
    player_position_ms = 0,
    next_queue_entry_id = NULL,
    target_vocal_mode = COALESCE(target_vocal_mode, 'instrumental'),
    playback_version = COALESCE(playback_version, 1),
    volume_percent = COALESCE(volume_percent, 50),
    media_started_at = NULL,
    playback_updated_at = COALESCE(playback_updated_at, now()),
    updated_at = now();

ALTER TABLE rooms
  ALTER COLUMN target_vocal_mode SET DEFAULT 'instrumental',
  ALTER COLUMN target_vocal_mode SET NOT NULL,
  ALTER COLUMN player_state SET DEFAULT 'idle',
  ALTER COLUMN player_state SET NOT NULL,
  ALTER COLUMN player_position_ms SET DEFAULT 0,
  ALTER COLUMN player_position_ms SET NOT NULL,
  ALTER COLUMN playback_version SET DEFAULT 1,
  ALTER COLUMN playback_version SET NOT NULL,
  ALTER COLUMN volume_percent SET DEFAULT 50,
  ALTER COLUMN volume_percent SET NOT NULL,
  ALTER COLUMN playback_updated_at SET DEFAULT now(),
  ALTER COLUMN playback_updated_at SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'rooms_target_vocal_mode_check'
  ) THEN
    ALTER TABLE rooms
      ADD CONSTRAINT rooms_target_vocal_mode_check
      CHECK (target_vocal_mode IN ('original', 'instrumental', 'dual', 'unknown'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'rooms_player_state_check'
  ) THEN
    ALTER TABLE rooms
      ADD CONSTRAINT rooms_player_state_check
      CHECK (player_state IN ('idle', 'preparing', 'loading', 'playing', 'paused', 'recovering', 'error'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'rooms_player_position_ms_check'
  ) THEN
    ALTER TABLE rooms
      ADD CONSTRAINT rooms_player_position_ms_check CHECK (player_position_ms >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'rooms_playback_version_check'
  ) THEN
    ALTER TABLE rooms
      ADD CONSTRAINT rooms_playback_version_check CHECK (playback_version > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'rooms_volume_percent_check'
  ) THEN
    ALTER TABLE rooms
      ADD CONSTRAINT rooms_volume_percent_check CHECK (volume_percent >= 0 AND volume_percent <= 100);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS room_clients (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  client_type text NOT NULL CHECK (client_type IN ('tv', 'controller')),
  device_id text NOT NULL,
  device_name text NOT NULL,
  last_seen_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  pairing_token text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(room_id, client_type, device_id),
  CONSTRAINT room_clients_controller_expiry_ck
    CHECK (client_type <> 'controller' OR expires_at IS NOT NULL)
);

DELETE FROM queue_entries;

DROP TABLE IF EXISTS playback_events;
DROP TABLE IF EXISTS playback_sessions;
DROP TABLE IF EXISTS control_commands;
DROP TABLE IF EXISTS control_sessions;
DROP TABLE IF EXISTS device_sessions;
DROP TABLE IF EXISTS room_pairing_tokens;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'rooms_default_player_device_fk'
  ) THEN
    ALTER TABLE rooms
      ADD CONSTRAINT rooms_default_player_device_fk
      FOREIGN KEY (default_player_device_id) REFERENCES room_clients(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'rooms_current_queue_entry_fk'
  ) THEN
    ALTER TABLE rooms
      ADD CONSTRAINT rooms_current_queue_entry_fk
      FOREIGN KEY (current_queue_entry_id) REFERENCES queue_entries(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'rooms_next_queue_entry_fk'
  ) THEN
    ALTER TABLE rooms
      ADD CONSTRAINT rooms_next_queue_entry_fk
      FOREIGN KEY (next_queue_entry_id) REFERENCES queue_entries(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'queue_entries_removed_by_control_session_fk'
  ) THEN
    ALTER TABLE queue_entries
      ADD CONSTRAINT queue_entries_removed_by_control_session_fk
      FOREIGN KEY (removed_by_control_session_id) REFERENCES room_clients(id) ON DELETE SET NULL;
  END IF;
END $$;

DROP INDEX IF EXISTS queue_entries_nas_song_counts_idx;

CREATE INDEX IF NOT EXISTS room_clients_room_type_seen_idx
  ON room_clients(room_id, client_type, last_seen_at DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS room_clients_controller_active_idx
  ON room_clients(room_id, expires_at, last_seen_at DESC)
  WHERE client_type = 'controller' AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS ktv_songs_request_count_idx
  ON ktv_songs(request_count DESC, last_requested_at DESC)
  WHERE request_count > 0;
