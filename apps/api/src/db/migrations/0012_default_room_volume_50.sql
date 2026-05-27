ALTER TABLE playback_sessions
  ALTER COLUMN volume_percent SET DEFAULT 50;

UPDATE playback_sessions
SET volume_percent = 50,
    updated_at = now()
WHERE volume_percent = 100;
