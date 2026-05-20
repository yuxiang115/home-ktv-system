---
phase: 19-search-and-queue-time-catalog-sync
plan: 02
subsystem: api-catalog
tags: [postgres, catalog-sync, ktv-index, source-records]

requires:
  - phase: 19-search-and-queue-time-catalog-sync
    provides: Indexed Mobile queue state and indexedAssetId command contract
provides:
  - Partial unique source_records identity for ktv-index assets
  - Idempotent selected indexed asset to canonical song/asset/source record sync
  - Stable stale and unreadable indexed asset errors
affects: [19-03, 19-04, playback-commands, catalog, source-records]

tech-stack:
  added: []
  patterns:
    - Deterministic canonical ids from ktv_songs.id and ktv_song_assets.id
    - Queue-time source readability classification via buildNasSample

key-files:
  created:
    - apps/api/src/db/migrations/0010_ktv_catalog_sync_source_identity.sql
    - apps/api/src/modules/catalog/ktv-catalog-sync-service.ts
    - .planning/phases/19-search-and-queue-time-catalog-sync/19-02-SUMMARY.md
  modified:
    - apps/api/src/db/schema.ts
    - apps/api/src/test/ktv-catalog-sync-service.test.ts

key-decisions:
  - "KTV source identity is persisted in source_records with provider ktv-index and provider_item_id equal to ktv_song_assets.id."
  - "Sync service writes canonical songs/assets with deterministic ids and leaves queue_entries strictly canonical."
  - "Unreadable or stale indexed assets fail before canonical writes whenever readability checking is enabled."

patterns-established:
  - "Catalog sync services can be constructed over any QueryExecutor so Phase 19-03 can run them inside a transaction-bound client."
  - "KTV indexed raw metadata stays in source_records.raw_meta and is not sent by Mobile."

requirements-completed: [SYNC-01, SYNC-02, SYNC-03]

duration: 11 min
completed: 2026-05-20
---

# Phase 19 Plan 02: KTV Catalog Sync Service Summary

**Selected KTV indexed assets now have a deterministic, idempotent path into canonical songs/assets/source_records.**

## Performance

- **Duration:** 11 min
- **Started:** 2026-05-20T11:58:29Z
- **Completed:** 2026-05-20T12:09:12Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Added `source_records_ktv_index_asset_uq`, scoped only to `provider = 'ktv-index'`.
- Implemented `PgKtvCatalogSyncService.syncIndexedAsset` with deterministic `song-ktv-*`, `asset-ktv-*`, and `source-ktv-index-asset-*` ids.
- Preserved source file path, relative path, title, artist, category, extension, size, and parse confidence in `source_records.raw_meta`.
- Added stale source and unreadable file rejection with `KTV_INDEX_ASSET_STALE` / `索引已失效` and `KTV_INDEX_FILE_UNREADABLE` / `文件不可读`.

## Task Commits

1. **Task 1: Add KTV source identity database guard** - `11849d2` (feat)
2. **Task 2: Implement idempotent KTV catalog sync service** - `ddaf198` (feat)

## Files Created/Modified

- `apps/api/src/db/migrations/0010_ktv_catalog_sync_source_identity.sql` - KTV partial unique source identity guard.
- `apps/api/src/db/schema.ts` - Mirrors the source identity guard in `schemaSql`.
- `apps/api/src/modules/catalog/ktv-catalog-sync-service.ts` - Sync service, errors, metadata mapping, and NAS readability guard.
- `apps/api/src/test/ktv-catalog-sync-service.test.ts` - Schema, idempotency, metadata, stale, unreadable, and failed-write coverage.

## Decisions Made

- Used deterministic ids instead of generated ids so repeated sync of the same indexed rows reuses canonical records.
- Kept compatibility as `unknown` and switch quality as `review_required`, because Phase 20 owns playback proof.
- The service does not open its own transaction; it accepts `QueryExecutor` so 19-03 can call it inside the indexed queue command transaction.

## Deviations from Plan

None - plan executed exactly as written.

**Total deviations:** 0 auto-fixed.  
**Impact on plan:** No scope change.

## Issues Encountered

- `apps/api/src/db/schema.ts` had pre-existing uncommitted KTV index schema changes. The Task 1 commit was corrected so it stages only the new 19-02 partial unique index while preserving the working tree changes.

## Verification

- `pnpm -F @home-ktv/api test -- src/test/ktv-catalog-sync-service.test.ts`
- `pnpm -F @home-ktv/api typecheck`

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Ready for 19-03. The sync service is transaction-compatible and can be composed into `add-queue-entry` before canonical queue mutation.

---
*Phase: 19-search-and-queue-time-catalog-sync*
*Completed: 2026-05-20*
