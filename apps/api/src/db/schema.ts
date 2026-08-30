export const defaultRoomSeed = {
  id: "living-room",
  slug: "living-room",
  name: "Living Room"
} as const;

export const tableNames = {
  rooms: "rooms",
  roomClients: "room_clients",
  queueEntries: "queue_entries",
  controllerUsers: "controller_users",
  controllerAuthSessions: "controller_auth_sessions",
  ktvSongs: "ktv_songs",
  onlineSupplementTasks: "online_supplement_tasks"
} as const;

export const enumValues = {
  songSourceType: ["nas", "online"],
  vocalMode: ["original", "instrumental", "dual", "unknown"],
  compatibilityStatus: ["unknown", "review_required", "playable", "unsupported"],
  roomStatus: ["active", "inactive", "maintenance"],
  queueEntryStatus: ["queued", "preparing", "loading", "playing", "played", "skipped", "failed", "removed"],
  clientType: ["tv", "controller"],
  playerState: ["idle", "preparing", "loading", "playing", "paused", "recovering", "error"],
  supplementTaskStatus: ["discovered", "processing", "ready", "failed"],
  supplementTaskStage: ["download", "rename", "vocal_remove", "align", "mix", "lyrics", "index"],
  supplementStageStatus: ["pending", "running", "done", "failed"]
} as const;

export interface RoomRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  default_player_device_id: string | null;
  pairing_token_value: string | null;
  pairing_token_hash: string | null;
  pairing_token_expires_at: Date | null;
  pairing_token_rotated_at: Date | null;
  current_queue_entry_id: string | null;
  target_vocal_mode: string;
  player_state: string;
  player_position_ms: number;
  next_queue_entry_id: string | null;
  playback_version: number;
  volume_percent: number;
  media_started_at: Date | null;
  playback_updated_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface QueueEntryRow {
  id: string;
  room_id: string;
  song_id: string;
  requested_by: string;
  requested_by_user_phone?: string | null;
  requested_by_name?: string | null;
  queue_position: number;
  status: string;
  priority: number;
  playback_options: Record<string, unknown>;
  requested_at: Date;
  started_at: Date | null;
  ended_at: Date | null;
  removed_at: Date | null;
  removed_by_control_session_id: string | null;
  undo_expires_at: Date | null;
}

export interface RoomClientRow {
  id: string;
  room_id: string;
  client_type: string;
  device_id: string;
  device_name: string;
  user_phone?: string | null;
  last_seen_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  capabilities: Record<string, unknown>;
  pairing_token: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ControllerUserRow {
  phone: string;
  display_name: string;
  password_hash: string;
  created_at: Date;
  updated_at: Date;
  last_login_at: Date | null;
}

export interface ControllerAuthSessionRow {
  id: string;
  phone: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
  last_seen_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface RoomPairingTokenRow {
  room_id: string;
  token_value: string | null;
  token_hash: string | null;
  token_expires_at: Date | null;
  rotated_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface OnlineSupplementTaskRow {
  id: string;
  room_id: string;
  provider: string;
  provider_candidate_id: string;
  source_url: string;
  title: string;
  artist_name: string;
  duration_ms: number | null;
  provider_payload: Record<string, unknown>;
  workflow_id: string;
  status: string;
  stage: string;
  stage_status: string;
  stage_progress_percent: number;
  stage_message: string;
  failure_reason: string | null;
  failure_stage: string | null;
  llm_renamed_title: string | null;
  final_file_path: string | null;
  lyric_file: string | null;
  ready_song_id: string | null;
  worker_id: string | null;
  worker_lease_until: Date | null;
  requested_by: string | null;
  download_at: Date | null;
  ready_at: Date | null;
  failed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export type DeviceSessionRow = RoomClientRow;
export type ControlSessionRow = RoomClientRow;

export const schemaSql = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS rooms (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'inactive', 'maintenance')),
  default_player_device_id text,
  pairing_token_value text,
  pairing_token_hash text,
  pairing_token_expires_at timestamptz,
  pairing_token_rotated_at timestamptz,
  current_queue_entry_id text,
  target_vocal_mode text NOT NULL DEFAULT 'instrumental' CHECK (target_vocal_mode IN ('original', 'instrumental', 'dual', 'unknown')),
  player_state text NOT NULL DEFAULT 'idle' CHECK (player_state IN ('idle', 'preparing', 'loading', 'playing', 'paused', 'recovering', 'error')),
  player_position_ms integer NOT NULL DEFAULT 0 CHECK (player_position_ms >= 0),
  seek_seq integer NOT NULL DEFAULT 0 CHECK (seek_seq >= 0),
  next_queue_entry_id text,
  playback_version integer NOT NULL DEFAULT 1 CHECK (playback_version > 0),
  volume_percent integer NOT NULL DEFAULT 50 CHECK (volume_percent >= 0 AND volume_percent <= 100),
  media_started_at timestamptz,
  playback_updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS queue_entries (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  song_id text NOT NULL,
  requested_by text NOT NULL,
  requested_by_user_phone text,
  requested_by_name text,
  queue_position integer NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'preparing', 'loading', 'playing', 'played', 'skipped', 'failed', 'removed')),
  priority integer NOT NULL DEFAULT 0,
  playback_options jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ended_at timestamptz,
  removed_at timestamptz,
  removed_by_control_session_id text,
  undo_expires_at timestamptz
);

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

CREATE TABLE IF NOT EXISTS room_clients (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  client_type text NOT NULL CHECK (client_type IN ('tv', 'controller')),
  device_id text NOT NULL,
  device_name text NOT NULL,
  user_phone text REFERENCES controller_users(phone) ON DELETE SET NULL,
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

ALTER TABLE rooms
  ADD CONSTRAINT rooms_default_player_device_fk
  FOREIGN KEY (default_player_device_id) REFERENCES room_clients(id) ON DELETE SET NULL;

ALTER TABLE rooms
  ADD CONSTRAINT rooms_current_queue_entry_fk
  FOREIGN KEY (current_queue_entry_id) REFERENCES queue_entries(id) ON DELETE SET NULL;

ALTER TABLE rooms
  ADD CONSTRAINT rooms_next_queue_entry_fk
  FOREIGN KEY (next_queue_entry_id) REFERENCES queue_entries(id) ON DELETE SET NULL;

ALTER TABLE queue_entries
  ADD CONSTRAINT queue_entries_removed_by_control_session_fk
  FOREIGN KEY (removed_by_control_session_id) REFERENCES room_clients(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS queue_entries_room_position_idx ON queue_entries(room_id, status, queue_position, priority);
CREATE INDEX IF NOT EXISTS queue_entries_room_effective_position_idx
  ON queue_entries(room_id, status, queue_position)
  WHERE status IN ('queued', 'preparing', 'loading', 'playing');
CREATE INDEX IF NOT EXISTS queue_entries_requested_by_user_idx
  ON queue_entries(requested_by_user_phone, requested_at DESC)
  WHERE requested_by_user_phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS controller_auth_sessions_active_idx
  ON controller_auth_sessions(phone, expires_at DESC)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS room_clients_room_type_seen_idx
  ON room_clients(room_id, client_type, last_seen_at DESC)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS room_clients_controller_active_idx
  ON room_clients(room_id, expires_at, last_seen_at DESC)
  WHERE client_type = 'controller' AND revoked_at IS NULL;

INSERT INTO rooms (id, slug, name, status)
VALUES ('living-room', 'living-room', 'Living Room', 'active')
ON CONFLICT (slug) DO NOTHING;

CREATE TABLE IF NOT EXISTS ktv_songs (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  title text NOT NULL,
  normalized_title text NOT NULL,
  title_pinyin text NOT NULL DEFAULT '',
  title_initials text NOT NULL DEFAULT '',
  primary_artist_name text NOT NULL,
  normalized_primary_artist_name text NOT NULL,
  artist_names text[] NOT NULL DEFAULT '{}',
  style_tags text[] NOT NULL DEFAULT '{}',
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
  source_root text NOT NULL DEFAULT '',
  ssh_host text,
  first_seen_run_id text,
  last_seen_run_id text,
  missing_at timestamptz,
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  last_requested_at timestamptz,
  cover_image_url text,
  cover_updated_at timestamptz,
  lyric_file text,
  karaoke_lyrics_file text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ktv_songs_file_path_uq
  ON ktv_songs(file_path);
CREATE INDEX IF NOT EXISTS ktv_songs_normalized_title_trgm_idx
  ON ktv_songs USING gin (normalized_title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ktv_songs_title_pinyin_trgm_idx
  ON ktv_songs USING gin (title_pinyin gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ktv_songs_title_initials_idx
  ON ktv_songs(title_initials);
CREATE INDEX IF NOT EXISTS ktv_songs_primary_artist_idx
  ON ktv_songs(normalized_primary_artist_name);
CREATE INDEX IF NOT EXISTS ktv_songs_artist_names_gin_idx
  ON ktv_songs USING gin (artist_names);
CREATE INDEX IF NOT EXISTS ktv_songs_style_tags_gin_idx
  ON ktv_songs USING gin (style_tags);
CREATE INDEX IF NOT EXISTS ktv_songs_request_count_idx
  ON ktv_songs(request_count DESC, last_requested_at DESC)
  WHERE request_count > 0;
CREATE INDEX IF NOT EXISTS ktv_songs_technical_status_idx
  ON ktv_songs(technical_status, updated_at DESC);
CREATE INDEX IF NOT EXISTS ktv_songs_active_idx
  ON ktv_songs(updated_at DESC, file_path ASC)
  WHERE missing_at IS NULL;

ALTER TABLE queue_entries
  ADD CONSTRAINT queue_entries_song_fk
  FOREIGN KEY (song_id) REFERENCES ktv_songs(id)
  ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS online_supplement_tasks (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_candidate_id text NOT NULL,
  source_url text NOT NULL,
  title text NOT NULL,
  artist_name text NOT NULL DEFAULT '',
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  provider_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  workflow_id text NOT NULL DEFAULT 'youtube-enhanced' CHECK (workflow_id IN ('youtube-basic', 'youtube-enhanced')),
  status text NOT NULL DEFAULT 'discovered' CHECK (status IN ('discovered', 'processing', 'ready', 'failed')),
  stage text NOT NULL DEFAULT 'download' CHECK (stage IN ('download', 'rename', 'vocal_remove', 'align', 'mix', 'lyrics', 'index')),
  stage_status text NOT NULL DEFAULT 'pending' CHECK (stage_status IN ('pending', 'running', 'done', 'failed')),
  stage_progress_percent integer NOT NULL DEFAULT 0 CHECK (stage_progress_percent >= 0 AND stage_progress_percent <= 100),
  stage_message text NOT NULL DEFAULT '',
  failure_reason text,
  failure_stage text,
  llm_renamed_title text,
  final_file_path text,
  lyric_file text,
  ready_song_id text REFERENCES ktv_songs(id) ON DELETE SET NULL,
  worker_id text,
  worker_lease_until timestamptz,
  requested_by text,
  download_at timestamptz,
  ready_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(room_id, provider, provider_candidate_id)
);

CREATE INDEX IF NOT EXISTS online_supplement_tasks_room_status_updated_idx
  ON online_supplement_tasks(room_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS online_supplement_tasks_stage_claim_idx
  ON online_supplement_tasks(stage, stage_status, updated_at ASC)
  WHERE status IN ('discovered', 'processing');

CREATE INDEX IF NOT EXISTS online_supplement_tasks_ready_song_idx
  ON online_supplement_tasks(ready_song_id)
  WHERE ready_song_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS online_supplement_tasks_lease_idx
  ON online_supplement_tasks(worker_lease_until)
  WHERE stage_status = 'running';
`;
