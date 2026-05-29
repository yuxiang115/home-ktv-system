# Database Schema

Last verified: 2026-05-29 against the deployed PostgreSQL database on `lxc-dev:/opt/home-ktv-system`.

Verification source:

```sh
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yml \
  exec -T postgres psql -U ktv -d home_ktv
```

The live database currently has 25 user tables. Column ordinal numbers in PostgreSQL have a few gaps because previous migrations dropped columns; this document lists only the columns that still exist.

## Domain Map

```text
Room and control
rooms
  -> room_pairing_tokens
  -> device_sessions
  -> control_sessions -> control_commands

Catalog: NAS
ktv_index_runs
  -> ktv_song_assets -> ktv_songs
ktv_songs
  -> ktv_song_artists -> ktv_artists
  -> ktv_song_style_tags -> ktv_style_tags -> ktv_style_groups
  -> ktv_song_tagging_status -> ktv_song_tagging_runs
ktv_song_tagging_cache

Catalog: online placeholder
online_songs -> online_song_assets
candidate_tasks -> online_song_assets

Queue and playback
queue_entries
  -> rooms
  -> ktv_song_assets + ktv_songs when source_type = 'nas'
  -> online_song_assets + online_songs when source_type = 'online'
playback_sessions -> queue_entries
playback_events -> queue_entries

Covers
song_cover_cache, keyed by source_kind + source_song_id

Operations
schema_migrations
queue_entries_unmapped_archive
```

## Table Overview

| Table | Approx rows | Purpose |
| --- | ---: | --- |
| `candidate_tasks` | 0 | Online candidate discovery/fetch workflow; currently unused in normal NAS playback. |
| `control_commands` | 45 | Idempotent control command audit/result log. |
| `control_sessions` | 15 | Mobile controller sessions for a room. |
| `device_sessions` | 9 | TV/mobile device presence. |
| `ktv_artists` | 8,557 | Artist dimension for the NAS catalog. |
| `ktv_index_runs` | 2 | NAS index job history. |
| `ktv_song_artists` | 35,991 | Many-to-many mapping from NAS songs to artists. |
| `ktv_song_assets` | 34,385 | Physical NAS media files and technical probe metadata. |
| `ktv_song_style_tags` | 61,502 | Many-to-many mapping from NAS songs to style tags. |
| `ktv_song_tagging_cache` | 4,996 | Provider/LLM tagging cache. |
| `ktv_song_tagging_runs` | 7 | Style tagging batch runs. |
| `ktv_song_tagging_status` | 21,797 | Per-song tagging status per source. |
| `ktv_songs` | 31,549 | Logical NAS song identity. |
| `ktv_style_groups` | 5 | Style tag group dimension. |
| `ktv_style_tags` | 111 | Style tag dimension. |
| `online_song_assets` | 0 | Online playable asset placeholder. |
| `online_songs` | 0 | Online song placeholder. |
| `playback_events` | 46 | Playback event log. |
| `playback_sessions` | 1 | Current playback state per room. |
| `queue_entries` | 18 | Room queue entries for NAS or online songs. |
| `queue_entries_unmapped_archive` | 0 | Migration archive for queue rows that could not be mapped during the NAS/online refactor. |
| `room_pairing_tokens` | 1 | Pairing token for room/device authorization. |
| `rooms` | 1 | KTV rooms. |
| `schema_migrations` | 17 | Applied migration filenames. |
| `song_cover_cache` | 300 | Cover lookup/cache metadata keyed by catalog source and song id. |

## Relationship Summary

### Room, Device, And Control

- `room_pairing_tokens.room_id -> rooms.id` with `ON DELETE CASCADE`.
- `device_sessions.room_id -> rooms.id` with `ON DELETE CASCADE`.
- `rooms.default_player_device_id -> device_sessions.id` with `ON DELETE SET NULL`.
- `control_sessions.room_id -> rooms.id` with `ON DELETE CASCADE`.
- `control_commands.room_id -> rooms.id` with `ON DELETE CASCADE`.
- `control_commands.control_session_id -> control_sessions.id` with `ON DELETE CASCADE`.

### NAS Catalog

- `ktv_song_assets.song_id -> ktv_songs.id` with `ON DELETE CASCADE`.
- `ktv_song_assets.first_seen_run_id -> ktv_index_runs.id` with `ON DELETE SET NULL`.
- `ktv_song_assets.last_seen_run_id -> ktv_index_runs.id` with `ON DELETE SET NULL`.
- `ktv_song_artists.song_id -> ktv_songs.id` with `ON DELETE CASCADE`.
- `ktv_song_artists.artist_id -> ktv_artists.id` with `ON DELETE CASCADE`.
- `ktv_style_tags.group_id -> ktv_style_groups.id` with `ON DELETE RESTRICT`.
- `ktv_song_style_tags.song_id -> ktv_songs.id` with `ON DELETE CASCADE`.
- `ktv_song_style_tags.tag_id -> ktv_style_tags.id` with `ON DELETE CASCADE`.
- `ktv_song_tagging_status.song_id -> ktv_songs.id` with `ON DELETE CASCADE`.
- `ktv_song_tagging_status.run_id -> ktv_song_tagging_runs.id` with `ON DELETE SET NULL`.
- `ktv_song_tagging_cache` has no foreign key; it is a provider/source cache keyed by `(source, cache_key)`.

### Online Catalog

- `online_song_assets.song_id -> online_songs.id` with `ON DELETE CASCADE`.
- `candidate_tasks.room_id -> rooms.id` with `ON DELETE CASCADE`.
- `candidate_tasks.ready_online_asset_id -> online_song_assets.id` with `ON DELETE SET NULL`.

### Queue And Playback

- `queue_entries.room_id -> rooms.id` with `ON DELETE CASCADE`.
- `queue_entries.removed_by_control_session_id -> control_sessions.id` with `ON DELETE SET NULL`.
- `queue_entries (nas_asset_id, nas_song_id) -> ktv_song_assets (id, song_id)` with `ON DELETE RESTRICT`.
- `queue_entries (online_asset_id, online_song_id) -> online_song_assets (id, song_id)` with `ON DELETE RESTRICT`.
- `playback_sessions.room_id -> rooms.id` with `ON DELETE CASCADE`.
- `playback_sessions.current_queue_entry_id -> queue_entries.id` with `ON DELETE SET NULL`.
- `playback_sessions.next_queue_entry_id -> queue_entries.id` with `ON DELETE SET NULL`.
- `playback_events.room_id -> rooms.id` with `ON DELETE CASCADE`.
- `playback_events.queue_entry_id -> queue_entries.id` with `ON DELETE SET NULL`.

### Covers

- `song_cover_cache` intentionally has no foreign key because it is polymorphic:
  - `source_kind = 'nas'` means `source_song_id` points to `ktv_songs.id`.
  - `source_kind = 'online'` means `source_song_id` points to `online_songs.id`.
- Uniqueness is enforced by `UNIQUE (source_kind, source_song_id)`.

## Important Constraints

- `queue_entries.source_type` is required.
- `queue_entries_source_identity_ck` enforces exactly one source identity:
  - `source_type = 'nas'`: `nas_song_id` and `nas_asset_id` must be present; online ids must be null.
  - `source_type = 'online'`: `online_song_id` and `online_asset_id` must be present; NAS ids must be null.
- `ktv_songs` has unique logical identity on `(normalized_title, normalized_primary_artist_name)`.
- `ktv_song_assets.file_path` is unique. There are currently two unique indexes on the same column: `ktv_song_assets_file_path_key` and `ktv_song_assets_path_uq`.
- `song_cover_cache.status` is one of `pending`, `found`, `not_found`, `failed`.
- `song_cover_cache.source_kind` is one of `nas`, `online`.

## Tables And Columns

### `candidate_tasks`

Online candidate workflow table. Current row count is 0.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | `text` | no | `gen_random_uuid()::text` | Primary key. |
| `room_id` | `text` | no | - | FK to `rooms.id`. |
| `provider` | `text` | no | - | Online provider. |
| `provider_candidate_id` | `text` | no | - | Provider candidate id. |
| `title` | `text` | no | - | Candidate title. |
| `artist_name` | `text` | no | - | Candidate artist. |
| `source_label` | `text` | no | - | Source display label. |
| `duration_ms` | `integer` | yes | - | Must be null or non-negative. |
| `candidate_type` | `text` | no | - | `mv`, `karaoke`, `audio`, or `unknown`. |
| `reliability_label` | `text` | no | - | `high`, `medium`, `low`, or `unknown`. |
| `risk_label` | `text` | no | - | `normal`, `risky`, or `blocked`. |
| `status` | `text` | no | `'discovered'` | Discovery/fetch lifecycle status. |
| `failure_reason` | `text` | yes | - | Failure details. |
| `recent_event` | `jsonb` | no | `'{}'::jsonb` | Recent workflow event payload. |
| `provider_payload` | `jsonb` | no | `'{}'::jsonb` | Raw provider payload. |
| `selected_at` | `timestamptz` | yes | - | Lifecycle timestamp. |
| `review_required_at` | `timestamptz` | yes | - | Lifecycle timestamp. |
| `fetching_at` | `timestamptz` | yes | - | Lifecycle timestamp. |
| `fetched_at` | `timestamptz` | yes | - | Lifecycle timestamp. |
| `ready_at` | `timestamptz` | yes | - | Lifecycle timestamp. |
| `failed_at` | `timestamptz` | yes | - | Lifecycle timestamp. |
| `stale_at` | `timestamptz` | yes | - | Lifecycle timestamp. |
| `promoted_at` | `timestamptz` | yes | - | Lifecycle timestamp. |
| `purged_at` | `timestamptz` | yes | - | Lifecycle timestamp. |
| `created_at` | `timestamptz` | no | `now()` | Created time. |
| `updated_at` | `timestamptz` | no | `now()` | Updated time. |
| `ready_source_type` | `text` | yes | - | Currently constrained to `online` when set. |
| `ready_online_asset_id` | `text` | yes | - | FK to `online_song_assets.id`. |

Key indexes and constraints:

- Primary key: `id`.
- Unique: `(room_id, provider, provider_candidate_id)`.
- Indexes: `(provider, provider_candidate_id)`, `(room_id, updated_at DESC)`, `(room_id, status, updated_at DESC)`.

### `control_commands`

Idempotent command log from controller clients.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `command_id` | `text` | no | - | Primary key; idempotency key from client. |
| `room_id` | `text` | no | - | FK to `rooms.id`. |
| `control_session_id` | `text` | no | - | FK to `control_sessions.id`. |
| `session_version` | `integer` | no | - | Must be non-negative. |
| `command_type` | `text` | no | - | Queue/playback command type. |
| `command_payload` | `jsonb` | no | `'{}'::jsonb` | Input payload. |
| `result_status` | `text` | no | - | `accepted`, `duplicate`, `conflict`, or `rejected`. |
| `result_payload` | `jsonb` | no | `'{}'::jsonb` | Result payload. |
| `created_at` | `timestamptz` | no | `now()` | Created time. |

Key indexes and constraints:

- Primary key: `command_id`.
- Index: `(room_id, created_at DESC)`.

### `control_sessions`

Mobile controller session table.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | `text` | no | `gen_random_uuid()::text` | Primary key. |
| `room_id` | `text` | no | - | FK to `rooms.id`. |
| `device_id` | `text` | no | - | Controller device id. |
| `device_name` | `text` | no | `'Mobile Controller'` | Display name. |
| `last_seen_at` | `timestamptz` | no | `now()` | Presence heartbeat. |
| `expires_at` | `timestamptz` | no | - | Session expiry. |
| `revoked_at` | `timestamptz` | yes | - | Revocation timestamp. |
| `created_at` | `timestamptz` | no | `now()` | Created time. |
| `updated_at` | `timestamptz` | no | `now()` | Updated time. |

Key indexes and constraints:

- Primary key: `id`.
- Unique: `(room_id, device_id)`.
- Active-session index: `(room_id, expires_at, last_seen_at DESC) WHERE revoked_at IS NULL`.

### `device_sessions`

TV/mobile device presence.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | `text` | no | `gen_random_uuid()::text` | Primary key. |
| `room_id` | `text` | no | - | FK to `rooms.id`. |
| `device_type` | `text` | no | - | `tv` or `mobile`. |
| `device_name` | `text` | no | - | Display name. |
| `last_seen_at` | `timestamptz` | yes | - | Presence heartbeat. |
| `capabilities` | `jsonb` | no | `'{}'::jsonb` | Device capability flags. |
| `pairing_token` | `text` | yes | - | Pairing token. |
| `created_at` | `timestamptz` | no | `now()` | Created time. |
| `updated_at` | `timestamptz` | no | `now()` | Updated time. |

Key indexes and constraints:

- Primary key: `id`.

### `ktv_artists`

Artist dimension for NAS songs.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | `text` | no | `gen_random_uuid()::text` | Primary key. |
| `name` | `text` | no | - | Display artist name. |
| `normalized_name` | `text` | no | - | Search/dedupe key. |
| `name_pinyin` | `text` | no | `''` | Pinyin search key. |
| `name_initials` | `text` | no | `''` | Initials search key. |
| `created_at` | `timestamptz` | no | `now()` | Created time. |
| `updated_at` | `timestamptz` | no | `now()` | Updated time. |

Key indexes and constraints:

- Primary key: `id`.
- Unique: `normalized_name`.
- Search indexes: GIN trigram on `normalized_name`, GIN trigram on `name_pinyin`.

### `ktv_index_runs`

NAS index job history.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | `text` | no | `gen_random_uuid()::text` | Primary key. |
| `source_root` | `text` | no | - | Indexed NAS root. |
| `ssh_host` | `text` | yes | - | Source host if indexed remotely. |
| `status` | `text` | no | `'running'` | `running`, `completed`, or `failed`. |
| `files_seen` | `integer` | no | `0` | Non-negative. |
| `songs_upserted` | `integer` | no | `0` | Non-negative. |
| `assets_upserted` | `integer` | no | `0` | Non-negative. |
| `error_message` | `text` | yes | - | Failure details. |
| `started_at` | `timestamptz` | no | `now()` | Start time. |
| `finished_at` | `timestamptz` | yes | - | Finish time. |
| `created_at` | `timestamptz` | no | `now()` | Created time. |
| `updated_at` | `timestamptz` | no | `now()` | Updated time. |

Key indexes and constraints:

- Primary key: `id`.
- Index: `(status, started_at DESC)`.

### `ktv_song_artists`

Many-to-many mapping from NAS songs to artists.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `song_id` | `text` | no | - | FK to `ktv_songs.id`. |
| `artist_id` | `text` | no | - | FK to `ktv_artists.id`. |
| `artist_order` | `integer` | no | `0` | Non-negative display/order value. |
| `created_at` | `timestamptz` | no | `now()` | Created time. |

Key indexes and constraints:

- Primary key: `(song_id, artist_id)`.
- Index: `(artist_id, song_id)`.

### `ktv_song_assets`

Physical NAS media files and technical probe metadata.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | `text` | no | `gen_random_uuid()::text` | Primary key. |
| `song_id` | `text` | no | - | FK to `ktv_songs.id`. |
| `file_path` | `text` | no | - | Absolute/source file path. |
| `relative_path` | `text` | no | - | Path relative to indexed root. |
| `file_name` | `text` | no | - | File name. |
| `extension` | `text` | no | - | File extension. |
| `size_bytes` | `bigint` | yes | - | Must be null or non-negative. |
| `mtime_ms` | `bigint` | yes | - | Must be null or non-negative. |
| `parse_strategy` | `text` | no | - | `filename`, `path`, `hybrid`, or `fallback`. |
| `parse_confidence` | `numeric` | no | - | Between 0 and 1. |
| `technical_status` | `text` | no | `'pending'` | `pending`, `probed`, or `failed`. |
| `technical_metadata` | `jsonb` | no | `'{}'::jsonb` | Probe metadata, including media stream details. |
| `first_seen_run_id` | `text` | yes | - | FK to `ktv_index_runs.id`. |
| `last_seen_run_id` | `text` | yes | - | FK to `ktv_index_runs.id`. |
| `missing_at` | `timestamptz` | yes | - | Set when file is missing in a later index run. |
| `created_at` | `timestamptz` | no | `now()` | Created time. |
| `updated_at` | `timestamptz` | no | `now()` | Updated time. |

Key indexes and constraints:

- Primary key: `id`.
- Unique: `file_path`.
- Unique composite: `(id, song_id)` for queue composite FK validation.
- Active asset index: `(song_id, updated_at DESC) WHERE missing_at IS NULL`.
- Technical status index: `(technical_status, updated_at DESC)`.
- Note: `ktv_song_assets_file_path_key` and `ktv_song_assets_path_uq` both enforce uniqueness on `file_path`.

### `ktv_song_style_tags`

Many-to-many mapping from NAS songs to style tags.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `song_id` | `text` | no | - | FK to `ktv_songs.id`. |
| `tag_id` | `text` | no | - | FK to `ktv_style_tags.id`. |
| `source` | `text` | no | - | Tagging source. |
| `confidence` | `numeric` | no | `0` | Between 0 and 1. |
| `evidence` | `jsonb` | no | `'{}'::jsonb` | Provider/LLM evidence payload. |
| `locked` | `boolean` | no | `false` | Manual lock flag. |
| `created_at` | `timestamptz` | no | `now()` | Created time. |
| `updated_at` | `timestamptz` | no | `now()` | Updated time. |

Key indexes and constraints:

- Primary key: `(song_id, tag_id, source)`.
- Indexes: `(tag_id, song_id)`, `(source, updated_at DESC)`.

### `ktv_song_tagging_cache`

Provider/source cache for style tagging.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `source` | `text` | no | - | Tagging source/provider. |
| `cache_key` | `text` | no | - | Source-specific cache key. |
| `payload` | `jsonb` | no | - | Cached response payload. |
| `created_at` | `timestamptz` | no | `now()` | Created time. |
| `updated_at` | `timestamptz` | no | `now()` | Updated time. |

Key indexes and constraints:

- Primary key: `(source, cache_key)`.
- Index: `(source, updated_at DESC)`.

### `ktv_song_tagging_runs`

Style tagging batch runs.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | `text` | no | `gen_random_uuid()::text` | Primary key. |
| `source` | `text` | no | - | Tagging source/provider. |
| `status` | `text` | no | `'running'` | `running`, `completed`, or `failed`. |
| `selected_count` | `integer` | no | `0` | Non-negative. |
| `processed_count` | `integer` | no | `0` | Non-negative. |
| `tagged_count` | `integer` | no | `0` | Non-negative. |
| `empty_count` | `integer` | no | `0` | Non-negative. |
| `failed_count` | `integer` | no | `0` | Non-negative. |
| `average_tags` | `numeric` | yes | - | Average generated tag count. |
| `options` | `jsonb` | no | `'{}'::jsonb` | Run options. |
| `summary` | `jsonb` | no | `'{}'::jsonb` | Run summary. |
| `error_message` | `text` | yes | - | Failure details. |
| `started_at` | `timestamptz` | no | `now()` | Start time. |
| `finished_at` | `timestamptz` | yes | - | Finish time. |
| `created_at` | `timestamptz` | no | `now()` | Created time. |
| `updated_at` | `timestamptz` | no | `now()` | Updated time. |

Key indexes and constraints:

- Primary key: `id`.
- Index: `(source, started_at DESC)`.

### `ktv_song_tagging_status`

Per-song tagging status per source.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `song_id` | `text` | no | - | FK to `ktv_songs.id`. |
| `source` | `text` | no | - | Tagging source/provider. |
| `status` | `text` | no | - | `pending`, `tagged`, `empty`, or `failed`. |
| `tag_count` | `integer` | no | `0` | Non-negative. |
| `confidence` | `numeric` | yes | - | Tagging confidence summary. |
| `run_id` | `text` | yes | - | FK to `ktv_song_tagging_runs.id`. |
| `error_message` | `text` | yes | - | Failure details. |
| `updated_at` | `timestamptz` | no | `now()` | Updated time. |
| `created_at` | `timestamptz` | no | `now()` | Created time. |

Key indexes and constraints:

- Primary key: `(song_id, source)`.
- Index: `(source, status, updated_at DESC)`.

### `ktv_songs`

Logical NAS song identity.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | `text` | no | `gen_random_uuid()::text` | Primary key. |
| `title` | `text` | no | - | Display song title. |
| `normalized_title` | `text` | no | - | Search/dedupe title key. |
| `title_pinyin` | `text` | no | `''` | Pinyin search key. |
| `title_initials` | `text` | no | `''` | Initials search key. |
| `primary_artist_name` | `text` | no | - | Display primary artist. |
| `normalized_primary_artist_name` | `text` | no | - | Search/dedupe artist key. |
| `created_at` | `timestamptz` | no | `now()` | Created time. |
| `updated_at` | `timestamptz` | no | `now()` | Updated time. |

Key indexes and constraints:

- Primary key: `id`.
- Unique: `(normalized_title, normalized_primary_artist_name)`.
- Search indexes: GIN trigram on `normalized_title`, GIN trigram on `title_pinyin`, btree on `title_initials`, btree on `normalized_primary_artist_name`.

### `ktv_style_groups`

Style tag group dimension.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | `text` | no | `gen_random_uuid()::text` | Primary key. |
| `name` | `text` | no | - | Group name. |
| `sort_order` | `integer` | no | `0` | Display order. |
| `enabled` | `boolean` | no | `true` | Whether group is visible/enabled. |
| `created_at` | `timestamptz` | no | `now()` | Created time. |
| `updated_at` | `timestamptz` | no | `now()` | Updated time. |

Key indexes and constraints:

- Primary key: `id`.
- Unique: `name`.

### `ktv_style_tags`

Style tag dimension.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | `text` | no | `gen_random_uuid()::text` | Primary key. |
| `group_id` | `text` | no | - | FK to `ktv_style_groups.id`. |
| `name` | `text` | no | - | Tag name. |
| `normalized_name` | `text` | no | - | Dedupe key. |
| `sort_order` | `integer` | no | `0` | Display order. |
| `enabled` | `boolean` | no | `true` | Whether tag is visible/enabled. |
| `created_at` | `timestamptz` | no | `now()` | Created time. |
| `updated_at` | `timestamptz` | no | `now()` | Updated time. |

Key indexes and constraints:

- Primary key: `id`.
- Unique: `normalized_name`.
- Index: `(group_id, sort_order, name)`.

### `online_song_assets`

Online playable asset placeholder. Current row count is 0.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | `text` | no | `gen_random_uuid()::text` | Primary key. |
| `song_id` | `text` | no | - | FK to `online_songs.id`. |
| `provider` | `text` | no | - | Online provider. |
| `provider_asset_id` | `text` | no | - | Provider asset id. |
| `media_url` | `text` | no | - | Playable media URL. |
| `cache_path` | `text` | yes | - | Optional local cache path. |
| `status` | `text` | no | - | `ready`, `caching`, `failed`, or `unavailable`. |
| `duration_ms` | `integer` | yes | - | Must be null or non-negative. |
| `metadata` | `jsonb` | no | `'{}'::jsonb` | Provider metadata. |
| `created_at` | `timestamptz` | no | `now()` | Created time. |
| `updated_at` | `timestamptz` | no | `now()` | Updated time. |

Key indexes and constraints:

- Primary key: `id`.
- Unique: `(provider, provider_asset_id)`.
- Unique composite: `(id, song_id)` for queue composite FK validation.

### `online_songs`

Online song placeholder. Current row count is 0.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | `text` | no | `gen_random_uuid()::text` | Primary key. |
| `provider` | `text` | no | - | Online provider. |
| `provider_song_id` | `text` | no | - | Provider song id. |
| `title` | `text` | no | - | Display title. |
| `normalized_title` | `text` | no | - | Search key. |
| `title_pinyin` | `text` | no | `''` | Pinyin search key. |
| `title_initials` | `text` | no | `''` | Initials search key. |
| `primary_artist_name` | `text` | no | - | Display primary artist. |
| `normalized_primary_artist_name` | `text` | no | - | Search key. |
| `tags` | `text[]` | no | `'{}'::text[]` | Provider tags. |
| `metadata` | `jsonb` | no | `'{}'::jsonb` | Provider metadata. |
| `created_at` | `timestamptz` | no | `now()` | Created time. |
| `updated_at` | `timestamptz` | no | `now()` | Updated time. |

Key indexes and constraints:

- Primary key: `id`.
- Unique: `(provider, provider_song_id)`.

### `playback_events`

Playback telemetry/event log.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | `text` | no | `gen_random_uuid()::text` | Primary key. |
| `room_id` | `text` | no | - | FK to `rooms.id`. |
| `queue_entry_id` | `text` | yes | - | Optional FK to `queue_entries.id`. |
| `event_type` | `text` | no | - | Event type. |
| `event_payload` | `jsonb` | no | `'{}'::jsonb` | Event payload. |
| `created_at` | `timestamptz` | no | `now()` | Created time. |

Key indexes and constraints:

- Primary key: `id`.
- Index: `(room_id, created_at DESC)`.

### `playback_sessions`

Current playback state per room.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `room_id` | `text` | no | - | Primary key and FK to `rooms.id`. |
| `current_queue_entry_id` | `text` | yes | - | Current queue entry. |
| `target_vocal_mode` | `text` | no | - | `original`, `instrumental`, `dual`, or `unknown`. |
| `player_state` | `text` | no | - | `idle`, `preparing`, `loading`, `playing`, `paused`, `recovering`, or `error`. |
| `player_position_ms` | `integer` | no | `0` | Non-negative playback position. |
| `next_queue_entry_id` | `text` | yes | - | Next queue entry. |
| `version` | `integer` | no | `1` | Positive state version. |
| `media_started_at` | `timestamptz` | yes | - | Current media start timestamp. |
| `updated_at` | `timestamptz` | no | `now()` | Updated time. |
| `volume_percent` | `integer` | no | `50` | 0 through 100. |

Key indexes and constraints:

- Primary key: `room_id`.

### `queue_entries`

Room queue entries. This is now source-aware and points directly at NAS or online catalog tables.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | `text` | no | `gen_random_uuid()::text` | Primary key. |
| `room_id` | `text` | no | - | FK to `rooms.id`. |
| `requested_by` | `text` | no | - | Requesting control/session label. |
| `queue_position` | `integer` | no | - | Queue ordering value. |
| `status` | `text` | no | - | `queued`, `preparing`, `loading`, `playing`, `played`, `skipped`, `failed`, or `removed`. |
| `priority` | `integer` | no | `0` | Priority value. |
| `playback_options` | `jsonb` | no | `'{}'::jsonb` | Per-entry playback options. |
| `requested_at` | `timestamptz` | no | `now()` | Request time. |
| `started_at` | `timestamptz` | yes | - | Start time. |
| `ended_at` | `timestamptz` | yes | - | End time. |
| `removed_at` | `timestamptz` | yes | - | Removal time. |
| `removed_by_control_session_id` | `text` | yes | - | FK to `control_sessions.id`. |
| `undo_expires_at` | `timestamptz` | yes | - | Undo deadline. |
| `source_type` | `text` | no | - | `nas` or `online`. |
| `nas_song_id` | `text` | yes | - | Required for NAS rows. |
| `nas_asset_id` | `text` | yes | - | Required for NAS rows. |
| `online_song_id` | `text` | yes | - | Required for online rows. |
| `online_asset_id` | `text` | yes | - | Required for online rows. |

Key indexes and constraints:

- Primary key: `id`.
- Source identity check: exactly one of NAS identity or online identity must be present.
- Composite NAS FK: `(nas_asset_id, nas_song_id) -> ktv_song_assets(id, song_id)`.
- Composite online FK: `(online_asset_id, online_song_id) -> online_song_assets(id, song_id)`.
- Active queue index: `(room_id, status, queue_position) WHERE status IN ('queued', 'preparing', 'loading', 'playing')`.
- Recommendation/count index: `(source_type, nas_song_id) WHERE source_type = 'nas'`.

### `queue_entries_unmapped_archive`

Migration archive created by the NAS/online catalog refactor. Current row count is 0.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | `text` | yes | - | Archived queue entry id. |
| `room_id` | `text` | yes | - | Archived room id. |
| `song_id` | `text` | yes | - | Legacy song id before refactor. |
| `asset_id` | `text` | yes | - | Legacy asset id before refactor. |
| `requested_by` | `text` | yes | - | Archived requester. |
| `queue_position` | `integer` | yes | - | Archived queue position. |
| `status` | `text` | yes | - | Archived status. |
| `priority` | `integer` | yes | - | Archived priority. |
| `playback_options` | `jsonb` | yes | - | Archived playback options. |
| `requested_at` | `timestamptz` | yes | - | Archived timestamp. |
| `started_at` | `timestamptz` | yes | - | Archived timestamp. |
| `ended_at` | `timestamptz` | yes | - | Archived timestamp. |
| `removed_at` | `timestamptz` | yes | - | Archived timestamp. |
| `removed_by_control_session_id` | `text` | yes | - | Archived control session id. |
| `undo_expires_at` | `timestamptz` | yes | - | Archived undo deadline. |
| `source_type` | `text` | yes | - | Archived source type. |
| `nas_song_id` | `text` | yes | - | Archived NAS song id. |
| `nas_asset_id` | `text` | yes | - | Archived NAS asset id. |
| `online_song_id` | `text` | yes | - | Archived online song id. |
| `online_asset_id` | `text` | yes | - | Archived online asset id. |
| `archived_at` | `timestamptz` | yes | - | Archive timestamp. |

Key indexes and constraints:

- No primary key or foreign keys. This is an archive table produced by `CREATE TABLE AS`.

### `room_pairing_tokens`

Pairing token table for room/device authorization.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `room_id` | `text` | no | - | Primary key and FK to `rooms.id`. |
| `token_value` | `text` | no | - | Pairing token value. |
| `token_hash` | `text` | no | - | Token hash. |
| `token_expires_at` | `timestamptz` | no | - | Expiry time. |
| `rotated_at` | `timestamptz` | no | `now()` | Last rotation time. |
| `created_at` | `timestamptz` | no | `now()` | Created time. |
| `updated_at` | `timestamptz` | no | `now()` | Updated time. |

Key indexes and constraints:

- Primary key: `room_id`.
- Index: `(room_id, token_expires_at)`.

### `rooms`

KTV room table.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | `text` | no | `gen_random_uuid()::text` | Primary key. |
| `slug` | `text` | no | - | Public/stable room slug. |
| `name` | `text` | no | - | Display name. |
| `status` | `text` | no | - | `active`, `inactive`, or `maintenance`. |
| `default_player_device_id` | `text` | yes | - | FK to `device_sessions.id`. |
| `created_at` | `timestamptz` | no | `now()` | Created time. |
| `updated_at` | `timestamptz` | no | `now()` | Updated time. |

Key indexes and constraints:

- Primary key: `id`.
- Unique: `slug`.

### `schema_migrations`

Applied migration registry.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `filename` | `text` | no | - | Primary key; migration filename. |
| `applied_at` | `timestamptz` | no | `now()` | Apply timestamp. |

Applied migrations in the live DB:

- `0001_media_contract.sql`
- `0002_library_ingest_admin.sql`
- `0003_room_sessions_control.sql`
- `0004_queue_commands.sql`
- `0005_catalog_search.sql`
- `0006_online_candidates.sql`
- `0007_real_mv_contracts.sql`
- `0008_ktv_full_index.sql`
- `0009_ktv_active_asset_indexes.sql`
- `0010_ktv_catalog_sync_source_identity.sql`
- `0011_room_volume_control.sql`
- `0012_default_room_volume_50.sql`
- `0013_ktv_style_tags.sql`
- `0014_ktv_tagging_cache.sql`
- `0015_ktv_tagging_status_per_source.sql`
- `0016_song_cover_cache.sql`
- `0017_nas_online_catalog_refactor.sql`

### `song_cover_cache`

Cover lookup/cache metadata keyed by source and song id.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | `text` | no | `gen_random_uuid()::text` | Primary key. |
| `source_kind` | `text` | no | - | `nas` or `online`. |
| `source_song_id` | `text` | no | - | Polymorphic song id for the selected source. |
| `title` | `text` | no | - | Song title used for lookup. |
| `artist_name` | `text` | no | - | Artist name used for lookup. |
| `normalized_title` | `text` | no | `''` | Normalized lookup key. |
| `normalized_artist_name` | `text` | no | `''` | Normalized lookup key. |
| `provider` | `text` | yes | - | Cover provider. |
| `provider_song_id` | `text` | yes | - | Provider song id. |
| `provider_payload` | `jsonb` | no | `'{}'::jsonb` | Raw provider payload. |
| `image_url` | `text` | yes | - | Current external cover image URL. |
| `status` | `text` | no | `'pending'` | `pending`, `found`, `not_found`, or `failed`. |
| `confidence` | `integer` | no | `0` | 0 through 100. |
| `error_message` | `text` | yes | - | Failure details. |
| `fetched_at` | `timestamptz` | yes | - | Last provider fetch timestamp. |
| `created_at` | `timestamptz` | no | `now()` | Created time. |
| `updated_at` | `timestamptz` | no | `now()` | Updated time. |

Key indexes and constraints:

- Primary key: `id`.
- Unique: `(source_kind, source_song_id)`.
- Lookup index: `(source_kind, source_song_id) WHERE status = 'found' AND image_url IS NOT NULL`.
- Status index: `(source_kind, status, updated_at)`.

## Discussion Notes

- `online_songs` and `online_song_assets` are empty placeholders. They exist so the queue can already support a clean `nas`/`online` source split later.
- `queue_entries` no longer uses the old `songs`/`assets` bridge tables. NAS queue rows point directly to `ktv_songs` and `ktv_song_assets` through `nas_song_id` and `nas_asset_id`.
- `queue_entries_unmapped_archive` is currently empty and only exists to preserve any rows that could not be mapped during the refactor.
- `song_cover_cache` is the right home for cover metadata. If we later cache images locally, the clean extension is to add fields such as `external_image_url`, `local_image_path`, `image_content_type`, `image_size_bytes`, and `downloaded_at` here, not on `ktv_songs` or `ktv_song_assets`.
- The duplicated unique indexes on `ktv_song_assets.file_path` are a small cleanup candidate for a future migration.
- The biggest relationship tradeoff is `song_cover_cache`: it uses a polymorphic `(source_kind, source_song_id)` key, so PostgreSQL cannot enforce a direct FK to both `ktv_songs` and `online_songs`. This is flexible, but weaker than concrete source-specific cover tables.
