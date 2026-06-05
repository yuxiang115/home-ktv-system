CREATE TABLE IF NOT EXISTS controller_users (
  phone text PRIMARY KEY,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE IF NOT EXISTS controller_auth_sessions (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  phone text NOT NULL REFERENCES controller_users(phone) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE room_clients
  ADD COLUMN IF NOT EXISTS user_phone text REFERENCES controller_users(phone) ON DELETE SET NULL;

ALTER TABLE queue_entries
  ADD COLUMN IF NOT EXISTS requested_by_user_phone text,
  ADD COLUMN IF NOT EXISTS requested_by_name text;

CREATE INDEX IF NOT EXISTS queue_entries_requested_by_user_idx
  ON queue_entries(requested_by_user_phone, requested_at DESC)
  WHERE requested_by_user_phone IS NOT NULL;

CREATE INDEX IF NOT EXISTS controller_auth_sessions_active_idx
  ON controller_auth_sessions(phone, expires_at DESC)
  WHERE revoked_at IS NULL;
