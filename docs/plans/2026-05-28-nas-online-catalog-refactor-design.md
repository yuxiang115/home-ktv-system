# NAS / Online Catalog Refactor Design

## Goal

Remove the legacy `songs` and `assets` catalog tables and make playback, queueing, search, discovery, covers, and controller UI operate directly on two song source families:

- `nas`: local NAS KTV files, backed by the existing `ktv_songs` and `ktv_song_assets` tables.
- `online`: future online songs, backed by new online catalog tables.

The first implementation should support `nas` end to end. `online` should have schema and type placeholders only, so the system does not need another catalog rewrite when online songs arrive.

This design assumes the old `song.json` import/admission workflow is retired. If that workflow must survive, it needs a separate NAS-native redesign and should not keep `songs/assets` alive.

## Current State

The current runtime has three catalog layers:

1. Legacy formal catalog:
   - `songs`
   - `assets`
   - `source_records`
   - import/admission/admin catalog routes

2. Real NAS index:
   - `ktv_songs`
   - `ktv_song_assets`
   - `ktv_artists`
   - style tag tables
   - technical probe metadata in `ktv_song_assets.technical_metadata`

3. Runtime bridge:
   - search and discovery read `ktv_songs` for indexed results
   - queueing an indexed song calls `PgKtvCatalogSyncService`
   - that service copies a NAS asset into `songs/assets`
   - `queue_entries` then stores legacy `song_id` and `asset_id`
   - playback resolves media through `AssetGateway -> AssetRepository -> assets`

This bridge is the main problem. It gives the system two identities for one NAS song:

```text
ktv_songs.id / ktv_song_assets.id
song-ktv-<ktv_songs.id> / asset-ktv-<ktv_song_assets.id>
```

It also means recommendation counts, cover lookup keys, queue state, admin views, and playback debugging need translation.

## Decision

Use source-aware queue entries and source-aware media resolution.

Do not create a new universal catalog table. Do not keep `songs/assets` as an internal compatibility layer.

The runtime should treat `ktv_songs/ktv_song_assets` as the primary NAS catalog and should store NAS queue entries by direct foreign key to those tables.

Physical table names can stay `ktv_*` for this refactor. The logical API/source name should become `nas`. Renaming `ktv_songs` to `nas_songs` in the same release would add risk without removing the bridge layer, so it should be deferred unless there is a strong reason to do it later.

## Design Principles

1. One runtime identity per song asset.

   A NAS asset is identified by `sourceType='nas'` and `ktv_song_assets.id`. There should be no generated `asset-ktv-*` copy in another table.

2. Source-specific storage, shared runtime contracts.

   NAS and online can have different tables because their ingestion, validation, and playback constraints differ. Queue, playback, controller, and TV contracts should use one shared source-aware shape.

3. No hidden bridge layer.

   Any code named "sync indexed asset to catalog", "canonical asset for indexed source", or "source record lookup" is a migration smell after this refactor.

4. Preserve user-visible behavior before adding features.

   The first release should keep search, recommendations, queue, playback, vocal switching, covers, and TV presence working. Online playback and extra NAS metadata editing are follow-up work.

5. Prefer explicit failure over silent fallback.

   A stale NAS asset, missing file, unmapped legacy queue row, or unsupported online source should return a clear error code or be marked failed. Do not silently queue a different asset.

## Non-Goals

- Do not preserve the old formal catalog/import workflow in the new runtime.
- Do not keep the `source_records` sync table.
- Do not keep `available-songs` as a production endpoint.
- Do not implement real online provider playback in this refactor.
- Do not rewrite the Android TV UI before the web UI and API contract are stable.

## Impact Map

| Area | Current Dependency | Target |
| --- | --- | --- |
| Queue storage | `queue_entries.song_id -> songs`, `asset_id -> assets` | `source_type`, `nas_song_id`, `nas_asset_id`, online placeholders |
| Playback state | `playback_sessions.active_asset_id -> assets` | derive active asset from `current_queue_entry_id` |
| Media streaming | `/media/:assetId` through `assets.file_path` | `/media/nas/:assetId` through `ktv_song_assets.file_path` |
| Search | `local` formal results plus `indexed` NAS results | `nas` results plus online candidates |
| Discovery | prefers `ktvIndex`, falls back to formal | direct NAS discovery |
| Recommendations | counts by legacy `queue_entries.song_id` | counts by `source_type + nas_song_id` |
| Covers | `formal` / `ktv-index` source keys | `nas` / `online` source keys |
| Controller | canonical add or `indexedAssetId` add | one add command: `sourceType + assetId` |
| TV Web | target identity mostly `assetId` | target identity `sourceType + assetId` |
| Android TV | target identity `assetId`, media URL opaque | minimally parse/pass `sourceType`; no UI redesign |
| Admin | formal catalog and KTV index pages | NAS diagnostics/catalog page only |
| Import workflow | writes formal catalog | retired in this release |
| Online tasks | can point to `assets.ready_asset_id` | point to future online asset fields only |

## Target Data Model

### Source Types

Add a shared source enum in domain/API code:

```ts
export type SongSourceType = "nas" | "online";
```

The external API should use `nas`, not `ktv-index`.

### Queue Entries

Replace the old legacy identity:

```text
queue_entries.song_id  -> songs.id
queue_entries.asset_id -> assets.id
```

with source-aware identity:

```sql
source_type text NOT NULL CHECK (source_type IN ('nas', 'online')),

nas_song_id text REFERENCES ktv_songs(id) ON DELETE RESTRICT,
nas_asset_id text REFERENCES ktv_song_assets(id) ON DELETE RESTRICT,

online_song_id text REFERENCES online_songs(id) ON DELETE RESTRICT,
online_asset_id text REFERENCES online_song_assets(id) ON DELETE RESTRICT
```

Add a strict source consistency check:

```sql
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
)
```

Keep queue behavior columns unchanged:

```text
room_id
requested_by
queue_position
status
priority
playback_options
requested_at
started_at
ended_at
removed_at
removed_by_control_session_id
undo_expires_at
```

Recommended indexes:

```sql
CREATE INDEX queue_entries_room_effective_position_idx
  ON queue_entries(room_id, status, queue_position)
  WHERE status IN ('queued', 'preparing', 'loading', 'playing');

CREATE INDEX queue_entries_nas_song_counts_idx
  ON queue_entries(source_type, nas_song_id)
  WHERE source_type = 'nas' AND status <> 'removed';
```

Add the online count index only when online playback is implemented.

Add an asset-to-song integrity constraint. PostgreSQL needs a unique referenced key for a composite FK, so add:

```sql
CREATE UNIQUE INDEX ktv_song_assets_id_song_id_uq
  ON ktv_song_assets(id, song_id);

ALTER TABLE queue_entries
  ADD CONSTRAINT queue_entries_nas_asset_song_fk
  FOREIGN KEY (nas_asset_id, nas_song_id)
  REFERENCES ktv_song_assets(id, song_id)
  ON DELETE RESTRICT;
```

Do the equivalent for online assets when online queueing is enabled.

### Playback Sessions

Remove:

```text
playback_sessions.active_asset_id
```

The active source asset should be derived from `playback_sessions.current_queue_entry_id`.

Reasoning:

- `current_queue_entry_id` is already the durable playback pointer.
- Keeping a separate `active_asset_id` means every source family needs duplicated active identity fields.
- Derivation avoids inconsistent state where the queue entry says one source asset and playback session says another.

Keep:

```text
current_queue_entry_id
next_queue_entry_id
target_vocal_mode
player_state
player_position_ms
version
media_started_at
volume_percent
updated_at
```

`startQueueEntry` should only update queue entry pointers and playback state. It should not store a standalone asset FK.

The domain model can keep `PlaybackSession.activeAssetId` during a short code migration if needed, but it should become a derived nullable field, not a database column. The preferred final domain shape removes it completely.

### Online Tables

Create minimal online tables now, but do not wire playback yet:

```sql
CREATE TABLE online_songs (
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

CREATE TABLE online_song_assets (
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
```

This gives the queue schema a real online target without forcing online behavior into the first release.

### Song Cover Cache

Change `song_cover_cache.source_kind` from:

```text
formal | ktv-index
```

to:

```text
nas | online
```

Migration:

```sql
UPDATE song_cover_cache
SET source_kind = 'nas'
WHERE source_kind = 'ktv-index';
```

Old `formal` cover rows become unreachable after `songs/assets` are removed. They should be deleted after optional backup:

```sql
DELETE FROM song_cover_cache
WHERE source_kind = 'formal';
```

Cover scripts should default to:

```text
source = nas
source_song_id = ktv_songs.id
```

### Candidate Tasks

`candidate_tasks.ready_asset_id` currently references `assets(id)`.

Replace it with future-compatible online fields:

```sql
ready_source_type text CHECK (ready_source_type IN ('online')),
ready_online_asset_id text REFERENCES online_song_assets(id) ON DELETE SET NULL
```

For the first NAS-only release, these fields can remain null. Existing task state and discovery UI can continue to work as task metadata, but promotion to the old `assets` table must be removed.

### Removed Tables

The target final schema should not contain:

```text
songs
assets
source_records
```

Drop the import/admission tables in the same release. The old import workflow exists to create formal `songs/assets`, so keeping it would preserve the wrong product model:

```text
import_scan_runs
import_files
import_candidates
import_candidate_files
```

## Target Domain Model

Replace legacy song/asset-centric queue identity with a media source reference:

```ts
export interface MediaSourceRef {
  sourceType: "nas" | "online";
  songId: string;
  assetId: string;
}

export interface QueueEntry {
  id: QueueEntryId;
  roomId: RoomId;
  source: MediaSourceRef;
  requestedBy: string;
  queuePosition: number;
  status: QueueEntryStatus;
  priority: number;
  playbackOptions: PlaybackOptions;
  requestedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  removedAt: string | null;
  removedByControlSessionId: ControlSessionId | null;
  undoExpiresAt: string | null;
}
```

For compatibility with UI code, queue previews can still expose top-level `songId` and `assetId`, but they must be source-native IDs and include `sourceType`:

```ts
export interface RoomQueueEntryPreview {
  queueEntryId: QueueEntryId;
  sourceType: "nas" | "online";
  songId: string;
  assetId: string;
  songTitle: string;
  artistName: string;
  requestedBy: string;
  queuePosition: number;
  status: QueueEntryStatus;
  canPromote: boolean;
  canDelete: boolean;
  undoExpiresAt: string | null;
}
```

Playback targets should also expose `sourceType`:

```ts
export interface PlaybackTarget {
  roomId: RoomId;
  sessionVersion: number;
  queueEntryId: QueueEntryId;
  sourceType: "nas" | "online";
  songId: string;
  assetId: string;
  currentQueueEntryPreview: QueueEntryPreview;
  playbackUrl: string;
  resumePositionMs: number;
  vocalMode: VocalMode;
  switchFamily: SwitchFamily | null;
  playbackProfile?: PlaybackProfile;
  selectedTrackRef?: TrackRef | null;
  nextQueueEntryPreview: QueueEntryPreview | null;
}
```

The TV client can continue comparing `assetId`, but the safer comparison is `(sourceType, assetId)`.

Player telemetry payloads should include `sourceType`:

```ts
export interface PlayerTelemetryEvent {
  roomId: RoomId;
  sessionVersion: number;
  queueEntryId: QueueEntryId;
  sourceType: "nas" | "online";
  assetId: string;
  vocalMode: VocalMode;
  playbackPositionMs: number;
  emittedAt: string;
}
```

During the first release, the API may accept missing `sourceType` from older TV clients and infer it from the queue entry. New Web TV and Android TV clients should send it.

## Playback Resolver

Deleting `assets` removes the place where playback fields currently live. The replacement should be a source-aware resolver:

```ts
export interface PlayableMediaAsset {
  sourceType: "nas" | "online";
  songId: string;
  assetId: string;
  title: string;
  artistName: string;
  displayName: string;
  filePath: string;
  status: "ready" | "unavailable" | "failed" | "stale";
  durationMs: number;
  compatibilityStatus: CompatibilityStatus;
  compatibilityReasons: readonly CompatibilityReason[];
  mediaInfoSummary: MediaInfoSummary;
  mediaInfoProvenance: MediaInfoProvenance;
  trackRoles: TrackRoles;
  playbackProfile: PlaybackProfile;
}
```

For NAS assets:

- Read `ktv_song_assets`.
- Join `ktv_songs`.
- Reject rows where `missing_at IS NOT NULL`.
- Resolve `file_path` through existing media path mappings.
- Read `mediaInfoSummary` and `mediaInfoProvenance` from `technical_metadata`.
- Infer track roles with the same logic currently used by `PgKtvCatalogSyncService`.
- Build a `single_file_audio_tracks` playback profile.

NAS playable status rules:

```text
missing_at IS NOT NULL                     -> stale / not queueable
technical_status = 'failed'                -> failed / not queueable unless explicitly retried after probe
audioTracks length >= 1                    -> playable
audioTracks length = 0 or missing metadata -> unavailable until probe or runtime fallback says otherwise
```

The current bridge allows some KTV-index assets through more leniently. This refactor should prefer correctness: if technical metadata is missing, run or request the NAS technical probe instead of synthesizing a weak playback target.

The resolver should live outside route code, for example:

```text
apps/api/src/modules/media/playable-media-repository.ts
apps/api/src/modules/media/nas-playable-media.ts
apps/api/src/modules/media/online-playable-media.ts
```

`AssetGateway` should become `MediaGateway`:

```ts
createPlaybackUrl(ref: MediaSourceRef): string
resolveForStreaming(ref: MediaSourceRef): Promise<MediaGatewayResolution>
```

Public media URLs should be source-aware:

```text
/media/nas/:assetId
/media/online/:assetId
```

The existing raw NAS route:

```text
/media/ktv-index/:indexedAssetId/raw
```

can remain temporarily for diagnostics, but playback should use `/media/nas/:assetId`.

Range request behavior and content-type inference should remain unchanged.

## Search And Discovery

### Search Response

Replace `local + indexed` with `nas + online`.

Target shape:

```ts
export interface SongSearchResponse {
  query: string;
  nas: {
    status: "available" | "unavailable";
    message: string;
    results: NasSongSearchResult[];
  };
  online: SongSearchOnlineResult;
}
```

`NasSongSearchResult` should be based on the current `SongSearchIndexedResult`, but rename identity fields:

```ts
export interface NasSongSearchVersionOption {
  assetId: string;       // ktv_song_assets.id
  displayName: string;
  sourceLabel: "NAS";
  extension: string;
  sizeBytes: number | null;
  audioTrackCount: number | null;
  styleTags?: readonly string[];
  category: string;
  queueState: "not_queued" | "queued" | "source_missing" | "file_unreadable";
  canQueue: boolean;
  disabledLabel: string | null;
}

export interface NasSongSearchResult {
  songId: string;        // ktv_songs.id
  title: string;
  artistName: string;
  styleTags?: readonly string[];
  category: string;
  sourceLabel: "NAS";
  matchReason: SongSearchMatchReason | "style";
  versions: NasSongSearchVersionOption[];
}
```

The controller add command should submit:

```json
{
  "sourceType": "nas",
  "assetId": "<ktv_song_assets.id>"
}
```

The API should derive `songId` from `ktv_song_assets.song_id`, not trust a client-provided song id.

### Discovery Response

Change:

```ts
export type SongDiscoverySource = "formal" | "ktv-index";
```

to:

```ts
export type SongDiscoverySource = "nas" | "online";
```

Discovery should use the NAS repository directly:

```text
ktv_songs
-> style tags
-> ktv_song_assets active rows
-> queue counts by source_type + nas_song_id
-> cover lookup by source_kind='nas' and source_song_id=ktv_songs.id
```

Recommendation weighting stays:

```text
weight = 1 + global_request_count * 4
```

but counts must come from source-aware queue rows.

## Queue Commands

Replace the current command body:

```ts
{ songId, assetId? } | { indexedAssetId }
```

with:

```ts
{
  sourceType: "nas" | "online";
  assetId: string;
}
```

For `sourceType = "nas"`:

1. Load `ktv_song_assets` by `assetId`.
2. Reject if no row, `missing_at` is set, or file path cannot be resolved/read.
3. Load joined `ktv_songs`.
4. Build `PlayableMediaAsset`.
5. Resolve preferred vocal mode:
   - use current room target mode if that track exists
   - otherwise default to `instrumental` when present
   - otherwise allow `original` only if original is the only track
6. Append queue entry with `source_type='nas'`, `nas_song_id`, `nas_asset_id`.
7. Sync playback session by current queue entry.
8. Return a fresh snapshot.

For `sourceType = "online"`:

- Return `ONLINE_PLAYBACK_NOT_IMPLEMENTED` until online assets are implemented.

Command idempotency remains based on `control_commands.command_id`. Stored command payloads should use the new source-aware shape. Old historical `command_payload` rows can remain JSON history; no migration is needed unless UI code reads them for replay.

Remove:

```text
PgIndexedQueueCommandService
PgKtvCatalogSyncService
PgIndexedSourceIdentityLookup
queueAdmissionSource='ktv-index'
```

## Playback And Switching

`buildPlaybackTarget` should:

1. Load room.
2. Load playback session.
3. Load current queue entry.
4. Resolve current queue entry through `PlayableMediaRepository`.
5. Build playback URL through `MediaGateway`.
6. Pick selected audio track by `playbackOptions.preferredVocalMode`.
7. Resolve next queue entry preview the same way.

`buildSwitchTarget` should operate on `PlayableMediaAsset`:

- NAS assets are single-file audio-track switch targets.
- The switch target should use `switchKind='audio_track'`.
- `fromAssetId` and `toAssetId` can be the same NAS asset id.
- `selectedTrackRef` changes according to target vocal mode.

Separate-asset switching from the old `assets.switch_family` model can be removed unless online implementation later needs it.

### Player Routes

Player event routes currently receive `queueEntryId` and `assetId`. They should accept:

```json
{
  "queueEntryId": "...",
  "sourceType": "nas",
  "assetId": "...",
  "playbackPositionMs": 1234
}
```

Validation should verify that the reported `sourceType + assetId` matches the queue entry referenced by `queueEntryId`. If an older TV client omits `sourceType`, infer it from the queue entry for one release and log a warning.

### Android TV Compatibility

No Android UI redesign is required in this refactor, but the Android TV client consumes playback contracts and posts telemetry. It must receive a minimal compatibility update:

- Parse `PlaybackTarget.sourceType`, defaulting to `nas` when absent.
- Include `sourceType` in telemetry payloads.
- Compare active target by `queueEntryId + sourceType + assetId`, not only `queueEntryId + assetId`.
- Keep using `playbackUrl` as opaque server-provided media URL.

This can be a small protocol update, not an Android UI phase.

## Admin And Import Boundaries

Remove or disable old formal catalog/admin import routes:

```text
/admin/catalog/songs
/admin/catalog/assets/:assetId
/admin/catalog/validate-songs-root
/admin/imports/*
/rooms/:roomSlug/available-songs
```

Keep and promote NAS index/admin routes:

```text
/admin/ktv-index/*
```

The Admin web app should stop showing "formal songs" maintenance as the main song catalog. It should show NAS diagnostics and later NAS metadata management.

The controller app is the product surface for song selection. It should not expose "indexed" terminology after this refactor.

## Migration Strategy

This should be a single breaking release with downtime, not a dual-write migration.

Reasoning:

- The system is self-hosted and not publicly multi-tenant.
- Maintaining both old and new queue identities would multiply code paths.
- The goal is to remove the conversion layer, not hide it.

### Pre-Migration Checks

Run before deploying the new code:

```sql
SELECT count(*) FROM ktv_songs;
SELECT count(*) FROM ktv_song_assets WHERE missing_at IS NULL;

SELECT qe.id, qe.song_id, qe.asset_id
FROM queue_entries qe
LEFT JOIN source_records sr
  ON sr.asset_id = qe.asset_id
 AND sr.provider = 'ktv-index'
WHERE qe.status IN ('queued', 'preparing', 'loading', 'playing')
  AND sr.provider_item_id IS NULL
  AND qe.asset_id NOT LIKE 'asset-ktv-%';
```

The second query should return zero active rows. If it returns rows, decide whether to mark them failed or archive them before the destructive migration.

### Migration Steps

1. Stop API, web, TV clients, and background tasks.
2. Take a database backup:

```bash
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yml exec -T postgres \
  pg_dump -U ktv -d home_ktv > backups/home_ktv-before-nas-online-refactor.sql
```

3. Apply a new migration, for example `0017_nas_online_catalog_refactor.sql`.
4. Create `online_songs` and `online_song_assets`.
5. Add new nullable source fields to `queue_entries`.
6. Backfill NAS queue entries from `source_records`:

```sql
UPDATE queue_entries qe
SET source_type = 'nas',
    nas_asset_id = sr.provider_item_id,
    nas_song_id = kta.song_id
FROM source_records sr
JOIN ktv_song_assets kta
  ON kta.id = sr.provider_item_id
WHERE sr.provider = 'ktv-index'
  AND sr.provider_item_id IS NOT NULL
  AND sr.asset_id = qe.asset_id;
```

7. Backfill fallback rows by stable prefixed ids:

```sql
UPDATE queue_entries qe
SET source_type = 'nas',
    nas_asset_id = regexp_replace(qe.asset_id, '^asset-ktv-', ''),
    nas_song_id = kta.song_id
FROM ktv_song_assets kta
WHERE qe.source_type IS NULL
  AND qe.asset_id LIKE 'asset-ktv-%'
  AND kta.id = regexp_replace(qe.asset_id, '^asset-ktv-', '');
```

8. Fail or archive unmapped active rows explicitly:

```sql
UPDATE queue_entries
SET status = 'failed',
    ended_at = COALESCE(ended_at, now())
WHERE source_type IS NULL
  AND status IN ('queued', 'preparing', 'loading', 'playing');
```

9. Delete unmapped non-active historical rows or copy them to an archive table first.
10. Add `NOT NULL` and source consistency constraints.
11. Drop old queue FKs and old `song_id` / `asset_id` columns.
12. Remove `playback_sessions.active_asset_id`.
13. Migrate `song_cover_cache` from `ktv-index` to `nas`, delete `formal`, and replace check constraint.
14. Replace `candidate_tasks.ready_asset_id` with online-ready fields.
15. Drop `source_records`.
16. Drop import/admission tables.
17. Drop `assets`.
18. Drop `songs`.
19. Update `apps/api/src/db/schema.ts` to match final schema.
20. Start new code.

### Migration Validation Queries

Run after migration and before exposing the controller:

```sql
SELECT count(*) AS unmapped_queue_entries
FROM queue_entries
WHERE source_type IS NULL;

SELECT count(*) AS bad_nas_queue_entries
FROM queue_entries qe
LEFT JOIN ktv_song_assets a
  ON a.id = qe.nas_asset_id
 AND a.song_id = qe.nas_song_id
WHERE qe.source_type = 'nas'
  AND a.id IS NULL;

SELECT source_kind, count(*)
FROM song_cover_cache
GROUP BY source_kind
ORDER BY source_kind;

SELECT to_regclass('public.songs') AS songs_table,
       to_regclass('public.assets') AS assets_table,
       to_regclass('public.source_records') AS source_records_table;
```

Expected:

```text
unmapped_queue_entries = 0
bad_nas_queue_entries = 0
song_cover_cache only has nas and later online
songs_table/assets_table/source_records_table are NULL
```

### Fresh Install Behavior

Do not rewrite historical migrations unless the project later chooses a migration squash.

For now:

- Existing migrations may create `songs/assets`.
- New migration `0017` drops them.
- `schema.ts` should represent the final post-migration schema, so schema tests assert that final schema does not include `CREATE TABLE IF NOT EXISTS songs` or `CREATE TABLE IF NOT EXISTS assets`.

## Code Changes

### API Modules To Remove

Remove:

```text
apps/api/src/modules/catalog/ktv-catalog-sync-service.ts
apps/api/src/modules/playback/indexed-queue-command-service.ts
apps/api/src/routes/available-songs.ts
```

Remove or disable old import/formal catalog runtime:

```text
apps/api/src/modules/catalog/admission-service.ts
apps/api/src/modules/catalog/repositories/song-repository.ts
apps/api/src/modules/catalog/repositories/asset-repository.ts
apps/api/src/routes/admin-catalog.ts
apps/api/src/routes/admin-imports.ts
apps/api/src/runtime/local-media-catalog.ts
```

If tests still need in-memory catalog behavior, provide narrow in-memory fakes for playback/search tests instead of keeping production formal catalog modules.

### API Modules To Add Or Replace

Add:

```text
apps/api/src/modules/media/media-source-ref.ts
apps/api/src/modules/media/playable-media-repository.ts
apps/api/src/modules/media/nas-playable-media-repository.ts
apps/api/src/modules/media/media-gateway.ts
apps/api/src/modules/search/nas-song-search-repository.ts
```

Keep and rename at boundaries:

```text
PgKtvIndexReadRepository -> PgNasSongSearchRepository or wrap it behind NAS naming
```

The SQL can still query `ktv_*` tables.

### Runtime Repositories

`createPgRuntimeRepositories` should expose:

```ts
{
  rooms,
  playbackSessions,
  queueEntries,
  playableMedia,
  mediaSearch,
  songCovers,
  pairingTokens,
  controlSessions,
  controlCommands,
  deviceSessions,
  playbackEvents
}
```

It should not expose production `songs` or `assets`.

### Server Wiring

Remove old registrations:

```text
registerAdminImportRoutes
registerAdminCatalogRoutes
registerAvailableSongsRoutes
PgIndexedQueueCommandService
PgIndexedSourceIdentityLookup
AssetGateway
```

Register:

```text
MediaGateway
NAS search/discovery routes
NAS queue command path
Admin KTV/NAS diagnostics
```

### Execution Phases

This implementation should be split into small, verifiable commits even though the release is breaking:

1. Contract and schema tests.
   - Add expected final contracts and failing schema assertions.
   - No production behavior changes yet.

2. Database migration and final schema.
   - Add `online_*` tables.
   - Convert `queue_entries`.
   - Convert cover source names.
   - Remove old FKs and tables.
   - Update `schema.ts`.

3. Source-aware domain and repositories.
   - Add `MediaSourceRef`, source-aware queue mapping, and NAS playable media repository.
   - Update repository tests.

4. Media gateway and playback target.
   - Replace `AssetGateway` usage with source-aware media gateway.
   - Update `/media/nas/:assetId`.
   - Update playback target and switch target builders.

5. Queue command rewrite.
   - Replace canonical/indexed add paths with `sourceType + assetId`.
   - Remove sync services.
   - Update conflict/idempotency tests.

6. Search, discovery, and covers.
   - Rename indexed API shape to NAS.
   - Update recommendation counts and cover lookups.
   - Keep online candidates visible but not playable.

7. Web clients.
   - Controller: NAS wording and source-aware add command.
   - TV Web: source-aware target comparison and telemetry.
   - Admin: remove formal catalog/import UI, promote NAS diagnostics.

8. Android TV protocol compatibility.
   - Minimal sourceType parsing, comparison, and telemetry.
   - No Android UI redesign.

9. Deployment scripts/docs.
   - Add migration backup checklist and smoke checks.

10. Full verification and deployment.
    - Run backend, frontend, Android tests that cover changed contracts.
    - Deploy with downtime and backup.

Do not start phase 5 until phase 2 and phase 3 tests pass. The riskiest failure mode is rewriting routes before the data model is stable.

## Frontend Changes

### Controller

Rename user-facing and internal concepts:

```text
indexed -> nas
KTV index results -> NAS 曲库
indexedAssetId -> assetId with sourceType='nas'
```

Update add queue calls:

```ts
addQueueEntry({
  sourceType: "nas",
  assetId
})
```

Recommended list cards should use `song.source === 'nas'` and version objects with `assetId`, not `indexedAssetId`.

Duplicate confirmation should key by:

```text
sourceType + assetId
```

not just `songId`.

### TV Web

TV Web should mostly consume playback contracts. Update comparisons from:

```ts
activeTarget.assetId === snapshot.currentTarget.assetId
```

to:

```ts
activeTarget.sourceType === snapshot.currentTarget.sourceType
activeTarget.assetId === snapshot.currentTarget.assetId
```

The video element should use the server-provided `playbackUrl`.

### Admin

Remove formal song maintenance UI and old import workflow tabs from the default navigation. Keep NAS diagnostics and route it as the primary song-library admin page.

## Deployment Plan

1. Commit and build locally.
2. Run API migration tests and route tests.
3. Build Docker images locally if possible.
4. Stop server deployment.
5. Backup database.
6. Deploy new code.
7. Run migrations.
8. Restart services.
9. Run deploy doctor.
10. Run web smoke:
    - admin loads
    - controller loads with token
    - TV heartbeat connects
    - discovery returns NAS songs
    - add queue returns accepted
    - control snapshot queue count updates
    - TV receives playback target
    - `/media/nas/:assetId` responds to range request

## Rollback

After `songs/assets` are dropped, rollback is restore-based:

1. Stop services.
2. Restore the pre-migration database backup.
3. Deploy previous code.
4. Restart services.
5. Run doctor and playback smoke.

Do not attempt a down migration that recreates `songs/assets` from `ktv_*`; it would reintroduce the bridge layer and may not recover all old formal/import data.

## Test Plan

### Schema Tests

Add tests that final schema:

- does not include `CREATE TABLE IF NOT EXISTS songs`
- does not include `CREATE TABLE IF NOT EXISTS assets`
- includes source-aware `queue_entries`
- includes `online_songs` and `online_song_assets`
- has no FK to `assets`
- has no `source_records`

### Migration Tests

Add migration-level tests for:

- queue rows mapped by `source_records`
- queue rows mapped by `asset-ktv-*` fallback
- unmapped active rows marked `failed`
- `song_cover_cache.ktv-index` migrated to `nas`
- `song_cover_cache.formal` removed
- `candidate_tasks.ready_asset_id` removed

### API Tests

Add or update tests for:

- `POST /rooms/:roomSlug/commands/add-queue-entry` accepts `{ sourceType: 'nas', assetId }`
- command rejects missing/stale NAS asset
- command rejects online source with `ONLINE_PLAYBACK_NOT_IMPLEMENTED`
- command returns fresh snapshot with queue count
- search returns `nas.results`
- discovery returns `source: 'nas'`
- discovery uses source-aware queue counts
- media route streams `/media/nas/:assetId`
- playback target resolves NAS song title, artist, playback profile, and selected audio track
- switch vocal mode changes selected audio track for NAS single-file assets

### Frontend Tests

Controller:

- search renders NAS results
- discovery add sends `{ sourceType: 'nas', assetId }`
- duplicate confirmation keys by source/asset
- queued state updates after accepted command
- no UI text says "KTV index" except admin diagnostics

TV Web:

- playback target identity includes source type
- target change detection uses source type plus asset id
- audio track switching still works

Admin:

- formal catalog nav is removed or hidden
- NAS diagnostics still render

### Deployment Smoke

Run after deploy:

```bash
bash deploy/docker/ktv.sh doctor
curl -sS "$API/health"
curl -sS "$API/rooms/living-room/songs/discovery?limit=5" | jq .
curl -I -H 'Range: bytes=0-1023' "$API/media/nas/<known-asset-id>"
```

Then manually verify:

- controller home recommendations show real NAS songs
- plus button adds immediately
- queue badge updates immediately
- control tab shows the queued row
- TV changes from idle/loading to playback

## Acceptance Criteria

- Production runtime no longer writes to `songs`, `assets`, or `source_records`.
- Final schema has no `songs` or `assets` tables.
- NAS search, discovery, queue, playback, switch vocal mode, recommendations, and covers work end to end.
- Queue entries store direct NAS identities.
- No controller path sends `indexedAssetId`.
- `PgKtvCatalogSyncService` and `PgIndexedQueueCommandService` are deleted.
- New code treats `online` as a first-class source type, even if online playback returns not implemented.
- Deployment runbook includes backup, migration, smoke, and rollback steps.

## Confirmed Implementation Decisions

1. Rename Admin "KTV Index" to "NAS 曲库" in this same release.

   Use NAS wording in UI text; keep DB table names unchanged.

2. Do not add generated web-compatible copies for NAS files in this refactor.

   Use existing direct NAS streaming first, then add a separate compatibility task if specific files fail in Web TV.
