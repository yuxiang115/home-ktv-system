export const defaultRoomSeed = {
  id: "living-room",
  slug: "living-room",
  name: "Living Room"
} as const;

export const tableNames = {
  rooms: "rooms",
  roomClients: "room_clients",
  queueEntries: "queue_entries",
  candidateTasks: "candidate_tasks",
  ktvSongs: "ktv_songs"
} as const;

export const enumValues = {
  songSourceType: ["nas", "online"],
  vocalMode: ["original", "instrumental", "dual", "unknown"],
  compatibilityStatus: ["unknown", "review_required", "playable", "unsupported"],
  roomStatus: ["active", "inactive", "maintenance"],
  queueEntryStatus: ["queued", "preparing", "loading", "playing", "played", "skipped", "failed", "removed"],
  clientType: ["tv", "controller"],
  playerState: ["idle", "preparing", "loading", "playing", "paused", "recovering", "error"],
  onlineCandidateTaskStatus: [
    "discovered",
    "selected",
    "review_required",
    "fetching",
    "fetched",
    "ready",
    "failed",
    "stale",
    "promoted",
    "purged"
  ],
  onlineCandidateType: ["mv", "karaoke", "audio", "unknown"],
  onlineCandidateRiskLabel: ["normal", "risky", "blocked"],
  onlineCandidateReliabilityLabel: ["high", "medium", "low", "unknown"]
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
  source_type: string;
  nas_song_id: string | null;
  nas_asset_id: string | null;
  online_song_id: string | null;
  online_asset_id: string | null;
  requested_by: string;
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
  last_seen_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  capabilities: Record<string, unknown>;
  pairing_token: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CandidateTaskRow {
  id: string;
  room_id: string;
  provider: string;
  provider_candidate_id: string;
  title: string;
  artist_name: string;
  source_label: string;
  duration_ms: number | null;
  candidate_type: string;
  reliability_label: string;
  risk_label: string;
  status: string;
  failure_reason: string | null;
  recent_event: Record<string, unknown>;
  provider_payload: Record<string, unknown>;
  ready_asset_id: string | null;
  ready_media_url: string | null;
  ready_cache_path: string | null;
  ready_metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  selected_at: Date | null;
  review_required_at: Date | null;
  fetching_at: Date | null;
  fetched_at: Date | null;
  ready_at: Date | null;
  failed_at: Date | null;
  stale_at: Date | null;
  promoted_at: Date | null;
  purged_at: Date | null;
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
  source_type text NOT NULL CHECK (source_type IN ('nas', 'online')),
  nas_song_id text,
  nas_asset_id text,
  online_song_id text,
  online_asset_id text,
  requested_by text NOT NULL,
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
CREATE INDEX IF NOT EXISTS room_clients_room_type_seen_idx
  ON room_clients(room_id, client_type, last_seen_at DESC)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS room_clients_controller_active_idx
  ON room_clients(room_id, expires_at, last_seen_at DESC)
  WHERE client_type = 'controller' AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS candidate_tasks (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_candidate_id text NOT NULL,
  title text NOT NULL,
  artist_name text NOT NULL,
  source_label text NOT NULL,
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  candidate_type text NOT NULL CHECK (candidate_type IN ('mv', 'karaoke', 'audio', 'unknown')),
  reliability_label text NOT NULL CHECK (reliability_label IN ('high', 'medium', 'low', 'unknown')),
  risk_label text NOT NULL CHECK (risk_label IN ('normal', 'risky', 'blocked')),
  status text NOT NULL DEFAULT 'discovered' CHECK (status IN (
    'discovered',
    'selected',
    'review_required',
    'fetching',
    'fetched',
    'ready',
    'failed',
    'stale',
    'promoted',
    'purged'
  )),
  failure_reason text,
  recent_event jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  ready_asset_id text,
  ready_media_url text,
  ready_cache_path text,
  ready_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  selected_at timestamptz,
  review_required_at timestamptz,
  fetching_at timestamptz,
  fetched_at timestamptz,
  ready_at timestamptz,
  failed_at timestamptz,
  stale_at timestamptz,
  promoted_at timestamptz,
  purged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(room_id, provider, provider_candidate_id)
);

CREATE INDEX IF NOT EXISTS candidate_tasks_room_status_updated_idx
  ON candidate_tasks(room_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS candidate_tasks_provider_candidate_idx
  ON candidate_tasks(provider, provider_candidate_id);
CREATE INDEX IF NOT EXISTS candidate_tasks_room_recent_idx
  ON candidate_tasks(room_id, updated_at DESC);

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
  ADD CONSTRAINT queue_entries_source_identity_ck
  CHECK (
    (
      source_type = 'nas'
      AND nas_song_id IS NOT NULL
      AND nas_asset_id IS NOT NULL
      AND online_song_id IS NULL
      AND online_asset_id IS NULL
    )
    OR
    (
      source_type = 'online'
      AND online_song_id IS NOT NULL
      AND online_asset_id IS NOT NULL
      AND nas_song_id IS NULL
      AND nas_asset_id IS NULL
    )
  );

ALTER TABLE queue_entries
  ADD CONSTRAINT queue_entries_nas_identity_ck
  CHECK (source_type <> 'nas' OR nas_song_id = nas_asset_id);

ALTER TABLE queue_entries
  ADD CONSTRAINT queue_entries_nas_song_fk
  FOREIGN KEY (nas_song_id) REFERENCES ktv_songs(id)
  ON DELETE RESTRICT;
`;
