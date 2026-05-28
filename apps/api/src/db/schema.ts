import type { MediaInfoProvenance, MediaInfoSummary, PlaybackProfile, TrackRoles } from "@home-ktv/domain";

export const defaultRoomSeed = {
  id: "living-room",
  slug: "living-room",
  name: "Living Room"
} as const;

export const tableNames = {
  songs: "songs",
  assets: "assets",
  rooms: "rooms",
  queueEntries: "queue_entries",
  deviceSessions: "device_sessions",
  playbackSessions: "playback_sessions",
  playbackEvents: "playback_events",
  importScanRuns: "import_scan_runs",
  importFiles: "import_files",
  importCandidates: "import_candidates",
  importCandidateFiles: "import_candidate_files",
  sourceRecords: "source_records",
  candidateTasks: "candidate_tasks",
  roomPairingTokens: "room_pairing_tokens",
  controlSessions: "control_sessions",
  controlCommands: "control_commands",
  songCoverCache: "song_cover_cache",
  ktvIndexRuns: "ktv_index_runs",
  ktvArtists: "ktv_artists",
  ktvSongs: "ktv_songs",
  ktvSongArtists: "ktv_song_artists",
  ktvSongAssets: "ktv_song_assets"
} as const;

export const enumValues = {
  songStatus: ["ready", "review_required", "unavailable"],
  sourceType: ["local", "online_cached", "online_ephemeral"],
  assetKind: ["video", "audio+lyrics", "dual-track-video"],
  lyricMode: ["hard_sub", "soft_sub", "external_lrc", "none"],
  vocalMode: ["original", "instrumental", "dual", "unknown"],
  assetStatus: ["ready", "caching", "failed", "unavailable", "stale", "promoted"],
  switchQualityStatus: ["verified", "review_required", "rejected", "unknown"],
  compatibilityStatus: ["unknown", "review_required", "playable", "unsupported"],
  roomStatus: ["active", "inactive", "maintenance"],
  queueEntryStatus: ["queued", "preparing", "loading", "playing", "played", "skipped", "failed", "removed"],
  deviceType: ["tv", "mobile"],
  playerState: ["idle", "preparing", "loading", "playing", "paused", "recovering", "error"],
  importScanTrigger: ["manual", "scheduled", "watcher"],
  importScanStatus: ["queued", "running", "completed", "failed"],
  importScanScope: ["imports", "songs", "all"],
  importFileRootKind: ["imports_pending", "imports_needs_review", "songs"],
  importFileProbeStatus: ["pending", "probed", "failed", "skipped", "deleted"],
  importCandidateStatus: [
    "pending",
    "held",
    "review_required",
    "conflict",
    "approved",
    "rejected_deleted",
    "approval_failed"
  ],
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

export interface SongRow {
  id: string;
  title: string;
  normalized_title: string;
  title_pinyin: string;
  title_initials: string;
  artist_id: string;
  artist_name: string;
  artist_pinyin: string;
  artist_initials: string;
  language: string;
  status: string;
  genre: readonly string[];
  tags: readonly string[];
  aliases: readonly string[];
  search_hints: readonly string[];
  release_year: number | null;
  canonical_duration_ms: number | null;
  search_weight: number;
  default_asset_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AssetRow {
  id: string;
  song_id: string;
  source_type: string;
  asset_kind: string;
  display_name: string;
  file_path: string;
  duration_ms: number;
  lyric_mode: string;
  vocal_mode: string;
  status: string;
  switch_family: string | null;
  switch_quality_status: string;
  compatibility_status: string;
  compatibility_reasons: Record<string, unknown>[];
  media_info_summary: MediaInfoSummary;
  media_info_provenance: MediaInfoProvenance;
  track_roles: TrackRoles;
  playback_profile: PlaybackProfile;
  created_at: Date;
  updated_at: Date;
}

export interface RoomRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  default_player_device_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface QueueEntryRow {
  id: string;
  room_id: string;
  song_id: string;
  asset_id: string;
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

export interface DeviceSessionRow {
  id: string;
  room_id: string;
  device_type: string;
  device_name: string;
  last_seen_at: Date | null;
  capabilities: Record<string, unknown>;
  pairing_token: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface PlaybackSessionRow {
  room_id: string;
  current_queue_entry_id: string | null;
  active_asset_id: string | null;
  target_vocal_mode: string;
  player_state: string;
  player_position_ms: number;
  next_queue_entry_id: string | null;
  version: number;
  media_started_at: Date | null;
  updated_at: Date;
}

export interface PlaybackEventRow {
  id: string;
  room_id: string;
  queue_entry_id: string | null;
  event_type: string;
  event_payload: Record<string, unknown>;
  created_at: Date;
}

export interface ImportScanRunRow {
  id: string;
  trigger: string;
  status: string;
  scope: string;
  files_seen: number;
  files_added: number;
  files_changed: number;
  files_deleted: number;
  candidates_created: number;
  candidates_updated: number;
  error_message: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ImportFileRow {
  id: string;
  last_seen_scan_run_id: string | null;
  root_kind: string;
  relative_path: string;
  size_bytes: number;
  mtime_ms: number;
  quick_hash: string | null;
  probe_status: string;
  probe_payload: Record<string, unknown>;
  duration_ms: number | null;
  last_scanned_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ImportCandidateRow {
  id: string;
  status: string;
  title: string;
  normalized_title: string;
  title_pinyin: string;
  title_initials: string;
  artist_id: string | null;
  artist_name: string;
  language: string;
  genre: readonly string[];
  tags: readonly string[];
  aliases: readonly string[];
  search_hints: readonly string[];
  release_year: number | null;
  canonical_duration_ms: number | null;
  default_candidate_file_id: string | null;
  same_version_confirmed: boolean;
  conflict_song_id: string | null;
  review_notes: string | null;
  candidate_meta: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface ImportCandidateFileRow {
  id: string;
  candidate_id: string;
  import_file_id: string;
  selected: boolean;
  proposed_vocal_mode: string | null;
  proposed_asset_kind: string | null;
  role_confidence: number | null;
  probe_duration_ms: number | null;
  probe_summary: Record<string, unknown>;
  compatibility_status: string;
  compatibility_reasons: Record<string, unknown>[];
  media_info_summary: MediaInfoSummary;
  media_info_provenance: MediaInfoProvenance;
  track_roles: TrackRoles;
  playback_profile: PlaybackProfile;
  created_at: Date;
  updated_at: Date;
}

export interface SourceRecordRow {
  id: string;
  asset_id: string;
  provider: string;
  provider_item_id: string | null;
  source_uri: string | null;
  import_file_id: string | null;
  raw_meta: Record<string, unknown>;
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
  token_value: string;
  token_hash: string;
  token_expires_at: Date;
  rotated_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface ControlSessionRow {
  id: string;
  room_id: string;
  device_id: string;
  device_name: string;
  last_seen_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ControlCommandRow {
  command_id: string;
  room_id: string;
  control_session_id: string;
  session_version: number;
  command_type: string;
  command_payload: Record<string, unknown>;
  result_status: string;
  result_payload: Record<string, unknown>;
  created_at: Date;
}

export interface ImportCandidateFileDetailRow {
  candidate_file_id: string;
  candidate_id: string;
  import_file_id: string;
  selected: boolean;
  proposed_vocal_mode: string | null;
  proposed_asset_kind: string | null;
  role_confidence: number | null;
  probe_duration_ms: number | null;
  probe_summary: Record<string, unknown>;
  compatibility_status: string;
  compatibility_reasons: Record<string, unknown>[];
  media_info_summary: MediaInfoSummary;
  media_info_provenance: MediaInfoProvenance;
  track_roles: TrackRoles;
  playback_profile: PlaybackProfile;
  candidate_file_created_at: Date;
  candidate_file_updated_at: Date;
  root_kind: string;
  relative_path: string;
  size_bytes: number;
  mtime_ms: number;
  quick_hash: string | null;
  probe_status: string;
  probe_payload: Record<string, unknown>;
  duration_ms: number | null;
  import_file_created_at: Date;
  import_file_updated_at: Date;
}

export const schemaSql = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS online_songs (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  provider text NOT NULL,
  provider_song_id text NOT NULL,
  title text NOT NULL,
  normalized_title text NOT NULL,
  title_pinyin text NOT NULL DEFAULT '',
  title_initials text NOT NULL DEFAULT '',
  primary_artist_name text NOT NULL,
  normalized_primary_artist_name text NOT NULL,
  tags text[] NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider, provider_song_id)
);

CREATE TABLE IF NOT EXISTS online_song_assets (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  song_id text NOT NULL REFERENCES online_songs(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_asset_id text NOT NULL,
  media_url text NOT NULL,
  cache_path text,
  status text NOT NULL CHECK (status IN ('ready', 'caching', 'failed', 'unavailable')),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider, provider_asset_id)
);

CREATE TABLE IF NOT EXISTS rooms (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'inactive', 'maintenance')),
  default_player_device_id text,
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

CREATE TABLE IF NOT EXISTS device_sessions (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  device_type text NOT NULL CHECK (device_type IN ('tv', 'mobile')),
  device_name text NOT NULL,
  last_seen_at timestamptz,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  pairing_token text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS playback_sessions (
  room_id text PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  current_queue_entry_id text REFERENCES queue_entries(id) ON DELETE SET NULL,
  target_vocal_mode text NOT NULL CHECK (target_vocal_mode IN ('original', 'instrumental', 'dual', 'unknown')),
  player_state text NOT NULL CHECK (player_state IN ('idle', 'preparing', 'loading', 'playing', 'paused', 'recovering', 'error')),
  player_position_ms integer NOT NULL DEFAULT 0 CHECK (player_position_ms >= 0),
  next_queue_entry_id text REFERENCES queue_entries(id) ON DELETE SET NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  volume_percent integer NOT NULL DEFAULT 50 CHECK (volume_percent >= 0 AND volume_percent <= 100),
  media_started_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS playback_events (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  queue_entry_id text REFERENCES queue_entries(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  event_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE rooms
  ADD CONSTRAINT rooms_default_player_device_fk
  FOREIGN KEY (default_player_device_id) REFERENCES device_sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS queue_entries_room_position_idx ON queue_entries(room_id, status, queue_position, priority);
CREATE INDEX IF NOT EXISTS queue_entries_room_effective_position_idx
  ON queue_entries(room_id, status, queue_position)
  WHERE status IN ('queued', 'preparing', 'loading', 'playing');
CREATE INDEX IF NOT EXISTS queue_entries_nas_song_counts_idx
  ON queue_entries(source_type, nas_song_id)
  WHERE source_type = 'nas' AND status <> 'removed';
CREATE INDEX IF NOT EXISTS playback_events_room_created_idx ON playback_events(room_id, created_at DESC);

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
  ready_source_type text CHECK (ready_source_type IN ('online')),
  ready_online_asset_id text REFERENCES online_song_assets(id) ON DELETE SET NULL,
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

INSERT INTO playback_sessions (room_id, target_vocal_mode, player_state, player_position_ms, version)
VALUES ('living-room', 'instrumental', 'idle', 0, 1)
ON CONFLICT (room_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS room_pairing_tokens (
  room_id text PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  token_value text NOT NULL,
  token_hash text NOT NULL,
  token_expires_at timestamptz NOT NULL,
  rotated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS control_sessions (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  device_name text NOT NULL DEFAULT 'Mobile Controller',
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(room_id, device_id)
);

CREATE TABLE IF NOT EXISTS control_commands (
  command_id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  control_session_id text NOT NULL REFERENCES control_sessions(id) ON DELETE CASCADE,
  session_version integer NOT NULL CHECK (session_version >= 0),
  command_type text NOT NULL CHECK (command_type IN (
    'add-queue-entry',
    'delete-queue-entry',
    'undo-delete-queue-entry',
    'promote-queue-entry',
    'skip-current',
    'switch-vocal-mode',
    'player-ended'
  )),
  command_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_status text NOT NULL CHECK (result_status IN ('accepted', 'duplicate', 'conflict', 'rejected')),
  result_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE queue_entries
  ADD CONSTRAINT queue_entries_removed_by_control_session_fk
  FOREIGN KEY (removed_by_control_session_id) REFERENCES control_sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS room_pairing_tokens_expiry_idx
  ON room_pairing_tokens(room_id, token_expires_at);

CREATE INDEX IF NOT EXISTS control_sessions_room_active_idx
  ON control_sessions(room_id, expires_at, last_seen_at DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS control_commands_room_created_idx
  ON control_commands(room_id, created_at DESC);

CREATE TABLE IF NOT EXISTS song_cover_cache (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  source_kind text NOT NULL CHECK (source_kind IN ('nas', 'online')),
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

CREATE TABLE IF NOT EXISTS ktv_index_runs (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  source_root text NOT NULL,
  ssh_host text,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  files_seen integer NOT NULL DEFAULT 0 CHECK (files_seen >= 0),
  songs_upserted integer NOT NULL DEFAULT 0 CHECK (songs_upserted >= 0),
  assets_upserted integer NOT NULL DEFAULT 0 CHECK (assets_upserted >= 0),
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ktv_artists (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name text NOT NULL,
  normalized_name text NOT NULL,
  name_pinyin text NOT NULL DEFAULT '',
  name_initials text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (normalized_name)
);

CREATE TABLE IF NOT EXISTS ktv_songs (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  title text NOT NULL,
  normalized_title text NOT NULL,
  title_pinyin text NOT NULL DEFAULT '',
  title_initials text NOT NULL DEFAULT '',
  primary_artist_name text NOT NULL,
  normalized_primary_artist_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ktv_song_artists (
  song_id text NOT NULL REFERENCES ktv_songs(id) ON DELETE CASCADE,
  artist_id text NOT NULL REFERENCES ktv_artists(id) ON DELETE CASCADE,
  artist_order integer NOT NULL DEFAULT 0 CHECK (artist_order >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (song_id, artist_id)
);

CREATE TABLE IF NOT EXISTS ktv_song_assets (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  song_id text NOT NULL REFERENCES ktv_songs(id) ON DELETE CASCADE,
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
  first_seen_run_id text REFERENCES ktv_index_runs(id) ON DELETE SET NULL,
  last_seen_run_id text REFERENCES ktv_index_runs(id) ON DELETE SET NULL,
  missing_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (file_path)
);

CREATE INDEX IF NOT EXISTS ktv_index_runs_status_idx
  ON ktv_index_runs(status, started_at DESC);
CREATE INDEX IF NOT EXISTS ktv_artists_normalized_name_trgm_idx
  ON ktv_artists USING gin (normalized_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ktv_artists_name_pinyin_trgm_idx
  ON ktv_artists USING gin (name_pinyin gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ktv_songs_normalized_title_trgm_idx
  ON ktv_songs USING gin (normalized_title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ktv_songs_title_pinyin_trgm_idx
  ON ktv_songs USING gin (title_pinyin gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ktv_songs_title_initials_idx
  ON ktv_songs(title_initials);
CREATE INDEX IF NOT EXISTS ktv_songs_primary_artist_idx
  ON ktv_songs(normalized_primary_artist_name);
CREATE UNIQUE INDEX IF NOT EXISTS ktv_songs_normalized_title_artist_uq
  ON ktv_songs(normalized_title, normalized_primary_artist_name);
CREATE INDEX IF NOT EXISTS ktv_song_artists_artist_idx
  ON ktv_song_artists(artist_id, song_id);
CREATE UNIQUE INDEX IF NOT EXISTS ktv_song_assets_path_uq
  ON ktv_song_assets(file_path);
CREATE UNIQUE INDEX IF NOT EXISTS ktv_song_assets_id_song_id_uq
  ON ktv_song_assets(id, song_id);
CREATE INDEX IF NOT EXISTS ktv_song_assets_song_idx
  ON ktv_song_assets(song_id);
CREATE INDEX IF NOT EXISTS ktv_song_assets_technical_status_idx
  ON ktv_song_assets(technical_status, updated_at DESC);
CREATE INDEX IF NOT EXISTS ktv_song_assets_active_song_idx
  ON ktv_song_assets(song_id, updated_at DESC)
  WHERE missing_at IS NULL;

CREATE TABLE IF NOT EXISTS ktv_style_groups (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name text NOT NULL UNIQUE,
  sort_order integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ktv_style_tags (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  group_id text NOT NULL REFERENCES ktv_style_groups(id) ON DELETE RESTRICT,
  name text NOT NULL,
  normalized_name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (normalized_name)
);

CREATE TABLE IF NOT EXISTS ktv_song_style_tags (
  song_id text NOT NULL REFERENCES ktv_songs(id) ON DELETE CASCADE,
  tag_id text NOT NULL REFERENCES ktv_style_tags(id) ON DELETE CASCADE,
  source text NOT NULL,
  confidence numeric(4,3) NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  locked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (song_id, tag_id, source)
);

CREATE TABLE IF NOT EXISTS ktv_song_tagging_runs (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  source text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  selected_count integer NOT NULL DEFAULT 0 CHECK (selected_count >= 0),
  processed_count integer NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
  tagged_count integer NOT NULL DEFAULT 0 CHECK (tagged_count >= 0),
  empty_count integer NOT NULL DEFAULT 0 CHECK (empty_count >= 0),
  failed_count integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  average_tags numeric(8,3),
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ktv_song_tagging_status (
  song_id text NOT NULL REFERENCES ktv_songs(id) ON DELETE CASCADE,
  source text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'tagged', 'empty', 'failed')),
  tag_count integer NOT NULL DEFAULT 0 CHECK (tag_count >= 0),
  confidence numeric(4,3),
  run_id text REFERENCES ktv_song_tagging_runs(id) ON DELETE SET NULL,
  error_message text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (song_id, source)
);

CREATE INDEX IF NOT EXISTS ktv_style_tags_group_idx
  ON ktv_style_tags(group_id, sort_order, name);
CREATE INDEX IF NOT EXISTS ktv_song_style_tags_tag_idx
  ON ktv_song_style_tags(tag_id, song_id);
CREATE INDEX IF NOT EXISTS ktv_song_style_tags_source_idx
  ON ktv_song_style_tags(source, updated_at DESC);
CREATE INDEX IF NOT EXISTS ktv_song_tagging_runs_source_started_idx
  ON ktv_song_tagging_runs(source, started_at DESC);
CREATE INDEX IF NOT EXISTS ktv_song_tagging_status_source_status_idx
  ON ktv_song_tagging_status(source, status, updated_at DESC);

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

CREATE UNIQUE INDEX IF NOT EXISTS online_song_assets_id_song_id_uq
  ON online_song_assets(id, song_id);

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
  ADD CONSTRAINT queue_entries_nas_asset_song_fk
  FOREIGN KEY (nas_asset_id, nas_song_id)
  REFERENCES ktv_song_assets(id, song_id)
  ON DELETE RESTRICT;

ALTER TABLE queue_entries
  ADD CONSTRAINT queue_entries_online_asset_song_fk
  FOREIGN KEY (online_asset_id, online_song_id)
  REFERENCES online_song_assets(id, song_id)
  ON DELETE RESTRICT;
`;
