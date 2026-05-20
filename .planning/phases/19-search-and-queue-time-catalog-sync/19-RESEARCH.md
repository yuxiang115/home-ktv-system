# Phase 19: Search and Queue-Time Catalog Sync - Research

**Researched:** 2026-05-20
**Status:** Complete

## Research Question

What needs to be known to plan queue-time catalog sync from `ktv_*` indexed results into canonical `songs/assets`, while preserving the existing queue/playback ID model and Mobile search behavior?

## Existing Shape

- Phase 18 added `/rooms/:roomSlug/songs/search` with required `local`, `indexed`, and `online` sections.
- `SongSearchResponse.indexed.results[].versions[]` already carries `indexedAssetId`, extension, category, source label, and disabled queue state.
- `PgKtvIndexReadRepository.searchIndexedSongs` reads active `ktv_song_assets` rows with `missing_at IS NULL` and does not expose `file_path` to Mobile.
- `source_records` already exists with `provider`, `provider_item_id`, `source_uri`, `asset_id`, and `raw_meta`; it is the best current place to persist KTV index source identity.
- `queue_entries` stores canonical `song_id` and `asset_id` only. This should remain unchanged.
- Existing `add-queue-entry` command centralizes command idempotency, session-version conflict handling, duplicate command detection, queue append, playback-session sync, snapshot rebuild, and realtime broadcast.
- Existing Mobile runtime already has duplicate confirmation, command error handling, and search rendering that can be extended for indexed queue requests.

## Planning Conclusions

### Source Identity And Canonical IDs

Use the KTV index row ids as durable identities:

- `ktv_songs.id` -> one canonical Song.
- `ktv_song_assets.id` -> one canonical Asset.

Recommended deterministic canonical ids:

- Song id: `song-ktv-${indexedSongId}`
- Asset id: `asset-ktv-${indexedAssetId}`
- Source record id: `source-ktv-index-asset-${indexedAssetId}`

Add or maintain a partial unique identity for KTV source records:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS source_records_ktv_index_asset_uq
  ON source_records(provider, provider_item_id)
  WHERE provider = 'ktv-index' AND provider_item_id IS NOT NULL;
```

The sync service should still use deterministic ids with `ON CONFLICT(id)` so it remains idempotent even before or outside the partial index.

### Metadata Mapping

The KTV index has enough metadata for queue-time canonical records:

- Song: title, primary artist, category.
- Asset: file path, relative path, file name, extension, size, parse confidence.

Recommended canonical defaults:

- `songs.language = 'mandarin'`
- `songs.status = 'ready'`
- `songs.genre = ARRAY[category]` when category is non-empty
- `songs.tags` includes `ktv-index`
- `songs.search_hints` includes category, extension, and primary artist when non-empty
- `assets.source_type = 'local'`
- `assets.asset_kind = 'dual-track-video'`
- `assets.display_name = ktv_song_assets.file_name`
- `assets.file_path = ktv_song_assets.file_path`
- `assets.duration_ms = 0` until Phase 20 or later probe data supplies duration
- `assets.lyric_mode = 'none'`
- `assets.vocal_mode = 'dual'`
- `assets.status = 'ready'`
- `assets.switch_family = NULL`
- `assets.switch_quality_status = 'review_required'`
- `assets.compatibility_status = 'unknown'`
- `assets.compatibility_reasons` includes a warning such as `ktv-index-playback-unverified`
- `assets.media_info_summary.fileSizeBytes = sizeBytes ?? 0`
- `assets.media_info_provenance.importedFrom = 'ktv-index'`
- `assets.track_roles = { original: null, instrumental: null }`
- `assets.playback_profile.kind = 'single_file_audio_tracks'`
- `assets.playback_profile.requiresAudioTrackSelection = false`

This lets canonical rows exist and be queued without claiming browser playback or audio-track switching support before Phase 20.

### Queueability Versus Playback Proof

Current `addQueueEntry` rejects real-MV assets unless:

- `compatibilityStatus === 'playable'`
- the target vocal mode has a concrete `trackRoles` entry.

That was correct for Phase 15 real-MV review flows, but it conflicts with Phase 19's requirement that queue-time synced indexed songs are queueable before Phase 20 proves real playback.

Planning should introduce an explicit queue-admission path for KTV-index-synced assets:

- It may allow `assets.compatibility_status = 'unknown'` and missing track roles for `provider = 'ktv-index'`.
- It should set `playbackOptions.preferredVocalMode` only when a track role is known; otherwise let playback target carry `selectedTrackRef: null`.
- It must not mark switching as supported. `buildSwitchTarget` should continue returning `null` for missing track roles.
- Phase 20 will harden playback target status, media path mapping, and stream reachability.

### NAS Readability Boundary

The user selected blocking queueing when a path is unreadable or unmapped. This should be a bounded queue-time check, not full Phase 20 streaming verification.

Recommended approach:

- During sync, read the selected indexed asset row and latest source root.
- Run a single-asset readability check using the existing `buildNasSample` classification rules or an equivalent helper.
- If status is `unmapped`, `missing`, `unreadable`, or `timeout`, reject with a stable code and Chinese message:
  - code: `KTV_INDEX_FILE_UNREADABLE`
  - message: `文件不可读`
- If the source row is missing or `missing_at IS NOT NULL`, reject with:
  - code: `KTV_INDEX_ASSET_STALE`
  - message: `索引已失效`

Do not implement byte-range streaming, MIME validation, browser can-play checks, or track-switch probes in Phase 19.

### Atomicity

The user wants database conflicts or partial sync failures to roll back the sync and queue insertion together.

The safest implementation is to run indexed sync and queue mutation inside one PostgreSQL transaction for the indexed `add-queue-entry` path:

1. Open a `PoolClient`.
2. `BEGIN`.
3. Resolve the control session and room using transaction-bound repositories.
4. Run queue-time sync using the same client.
5. Execute the existing command flow with canonical `songId/assetId` using transaction-bound repositories.
6. `COMMIT` only after the command result is fully produced.
7. `ROLLBACK` on sync, validation, or queue mutation errors.

Existing repository constructors accept `QueryExecutor`, so a `PoolClient` can be used as a transaction-bound query executor. The server should expose or move the PostgreSQL repository factory so the indexed command coordinator can create repositories over the transaction client.

### API Contract

Extend the existing command, not the route family:

```json
POST /rooms/:roomSlug/commands/add-queue-entry
{
  "commandId": "...",
  "sessionVersion": 3,
  "deviceId": "...",
  "indexedAssetId": "..."
}
```

Rules:

- `indexedAssetId` is mutually exclusive with `songId` and `assetId`.
- Mobile must not send `indexedSongId`, file path, category, or other source metadata.
- The API resolves source rows server-side.
- Existing canonical `songId/assetId` requests continue to work unchanged.

### Mobile UX

Mobile should continue rendering indexed song groups with version rows. Changes for Phase 19:

- Queueable indexed version button label: `点歌`.
- Pending clicked version label: `正在加入...`.
- Queued state label: `已点`.
- Stale source disabled label: `索引已失效`.
- Unreadable path disabled or error label: `文件不可读`.
- Successful indexed queueing should keep the selected result in the KTV index section and update its state rather than moving it to the local section.

### Admin Traceability

Admin needs source traceability for canonical records created from the KTV index. Minimal Phase 19 surface:

- Add source identity fields to formal song detail or KTV diagnostics preview when a canonical record exists.
- Show `ktv_songs.id`, `ktv_song_assets.id`, and `file_path`.
- Keep this inside Songs/KTV diagnostics; no new top-level Admin tab.

## Test Strategy

Backend:

- Sync service tests prove deterministic ids, idempotent reuse, metadata preservation, source record persistence, stale-index rejection, unreadable path rejection, and transaction rollback.
- Command route/service tests prove canonical add still works, indexed add uses `indexedAssetId`, mixed canonical/indexed payload is rejected, duplicate confirmation reuses canonical Song semantics, and `queue_entries` stores canonical ids only.
- Search route tests prove indexed versions can be queueable/queued/disabled and do not include NAS paths in Mobile JSON.
- Realtime or room snapshot tests prove accepted indexed commands broadcast snapshots with canonical queue previews.

Frontend:

- Mobile tests prove indexed version rows show `点歌`, `正在加入...`, `已点`, `索引已失效`, and `文件不可读` as applicable.
- Mobile request tests prove indexed queueing sends `indexedAssetId` and does not send file paths, full metadata, `songId`, or `assetId`.
- Admin tests prove KTV source identity is visible for synced canonical records.

## Scope Guardrails

- Do not add `ktv_*` ids to `queue_entries`.
- Do not bulk sync the full KTV library.
- Do not require manual Admin approval before queueing.
- Do not expose NAS absolute paths in Mobile.
- Do not implement full media path mapping, streaming, browser playback verification, or Android TV playback.
- Do not claim original/accompaniment switching support for indexed assets without track-role evidence.

## RESEARCH COMPLETE

Phase 19 should be planned as an indexed source contract, a transaction-safe catalog sync service, an indexed branch of the existing `add-queue-entry` command, and regression coverage proving canonical queue/realtime behavior.
