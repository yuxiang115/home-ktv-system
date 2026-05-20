---
phase: 19-search-and-queue-time-catalog-sync
plan: 04
subsystem: api-mobile-admin-regression
tags: [ktv-index, search, queue, realtime, admin, mobile, postgres]

requires:
  - phase: 19-search-and-queue-time-catalog-sync
    provides: Queue-time KTV index sync and canonical indexed add-queue-entry command flow
provides:
  - Queued-state search mapping for already-synced KTV indexed assets
  - Admin Songs source identity inspection for KTV-index-created canonical assets
  - Regression coverage for synced indexed queue operations and realtime snapshots
  - Final cross-package verification evidence for Phase 19
affects: [phase-20-real-scene-playback, mobile-search, admin-songs, realtime-snapshots, ktv-index]

tech-stack:
  added: []
  patterns:
    - KTV source identity is resolved through source_records for both Mobile search state and Admin traceability
    - Mobile indexed queue actions stay path-safe while Admin Songs can display operator-only source paths
    - Synced indexed queue tests assert canonical song-ktv/asset-ktv ids without storing indexed ids on queue rows

key-files:
  created:
    - .planning/phases/19-search-and-queue-time-catalog-sync/19-04-SUMMARY.md
  modified:
    - apps/api/src/routes/song-search.ts
    - apps/api/src/routes/admin-catalog.ts
    - apps/api/src/server.ts
    - apps/api/src/test/song-search-routes.test.ts
    - apps/api/src/test/admin-catalog-routes.test.ts
    - apps/api/src/test/indexed-queue-command.test.ts
    - apps/api/src/test/realtime-room-sync.test.ts
    - packages/domain/src/index.ts
    - apps/admin/src/songs/SongCatalogView.tsx
    - apps/admin/src/songs/types.ts
    - apps/admin/src/i18n.tsx
    - apps/admin/src/App.css
    - apps/admin/src/test/song-catalog.test.tsx
    - apps/mobile-controller/src/test/controller.test.tsx

key-decisions:
  - "Queued indexed search state is derived by mapping canonical queued asset ids back to ktv-index source_records."
  - "KTV source identity is exposed only in Admin Songs, including ktv_songs.id, ktv_song_assets.id, source file path, and parse confidence."
  - "Realtime and queue regression tests assert canonical queue preview ids and avoid raw NAS/index table leakage."

patterns-established:
  - "Search routes can accept a narrow indexed source identity lookup dependency rather than coupling Mobile search to ktv_* tables directly."
  - "Admin catalog serialization can enrich assets with optional operator-only diagnostics without changing Mobile contracts."
  - "Final phase closure keeps verification fixes in separate commits after RED/GREEN task commits."

requirements-completed: [SYNC-01, SYNC-02, SYNC-03, SYNC-04]

duration: 29 min
completed: 2026-05-20
---

# Phase 19 Plan 04: Search, Admin Traceability, and Regression Closure Summary

**Queued KTV indexed assets now show accurate Mobile search state, expose Admin source traceability, and have regression proof across queue, realtime, and UI flows.**

## Performance

- **Duration:** 29 min
- **Started:** 2026-05-20T12:36:43Z
- **Completed:** 2026-05-20T13:05:08Z
- **Tasks:** 4
- **Files modified:** 14

## Accomplishments

- Mobile search now marks already-queued synced indexed versions as `queued` while keeping them under `indexed.results` and omitting NAS paths.
- Admin Songs shows `KTV 同步来源` with `ktv_songs.id`, `ktv_song_assets.id`, file path, and parse confidence for canonical assets created from the KTV index.
- Queue operation coverage now proves promote, delete, undo, skip-current, and realtime broadcasts preserve canonical `song-ktv-*` / `asset-ktv-*` ids.
- Mobile coverage now proves tapping an indexed `已点` version opens the duplicate confirmation flow before sending `indexedAssetId`.
- Final verification passed across API, Admin, Mobile, and domain packages.

## Task Commits

1. **Task 1: Show synced indexed queue state in search** - `d6ef897` (test RED), `74cd886` (feat GREEN)
2. **Task 2: Add Admin source identity inspection for synced canonical records** - `3479e64` (test RED), `bcca141` (feat GREEN)
3. **Task 3: Prove queue/realtime operations for synced indexed songs** - `1227876` (test RED), `eb93226` (test GREEN)
4. **Task 4: Run final Phase 19 verification commands** - `8162ae5` (fix final API typecheck)

## Files Created/Modified

- `apps/api/src/routes/song-search.ts` - Maps queued canonical asset ids back to KTV indexed source ids for indexed search queue state.
- `apps/api/src/routes/admin-catalog.ts` - Adds source-record lookup and serialized `ktvIndexSource` details for Admin catalog assets.
- `apps/api/src/server.ts` - Wires KTV source identity lookup into PostgreSQL Admin catalog startup.
- `packages/domain/src/index.ts` - Adds `KtvIndexSyncedSourceRecord`.
- `apps/admin/src/songs/SongCatalogView.tsx` - Renders the Admin `KTV 同步来源` operator panel.
- `apps/admin/src/songs/types.ts` - Carries optional KTV source identity on Admin catalog assets.
- `apps/admin/src/i18n.tsx` - Adds Chinese and English source identity labels.
- `apps/admin/src/App.css` - Styles the source identity panel.
- `apps/api/src/test/song-search-routes.test.ts` - Covers queued indexed state and path-safe Mobile response.
- `apps/api/src/test/admin-catalog-routes.test.ts` - Covers Admin API source identity serialization.
- `apps/admin/src/test/song-catalog.test.tsx` - Covers Admin UI source identity rendering.
- `apps/api/src/test/indexed-queue-command.test.ts` - Covers indexed add, promote, delete, undo, skip, and canonical queue ids.
- `apps/api/src/test/realtime-room-sync.test.ts` - Covers realtime indexed add snapshot broadcast and raw-path safety.
- `apps/mobile-controller/src/test/controller.test.tsx` - Covers indexed duplicate confirmation from `已点`.

## Decisions Made

- Used `source_records.provider = 'ktv-index'` as the durable bridge from canonical queued assets back to indexed identities.
- Kept Admin source file paths operator-only; Mobile tests explicitly guard against NAS path and raw index leakage.
- Treated final API typecheck fixes as verification closure rather than product scope expansion.

## Deviations from Plan

None - plan executed within the specified Task 4 verification-and-fix scope.

**Total deviations:** 0 auto-fixed.  
**Impact on plan:** No scope change.

## Issues Encountered

- API typecheck initially failed on strict optional typing around `pool`, Admin source lookup test stubs, realtime snapshot test typing, and a computed test fixture key. Fixed in `8162ae5` and reran the full final command set successfully.

## Verification

- `pnpm -F @home-ktv/api test -- src/test/ktv-catalog-sync-service.test.ts src/test/indexed-queue-command.test.ts src/test/song-search-routes.test.ts src/test/realtime-room-sync.test.ts`
- `pnpm -F @home-ktv/admin test -- src/test/song-catalog.test.tsx`
- `pnpm -F @home-ktv/mobile-controller test -- src/test/controller.test.tsx`
- `pnpm -F @home-ktv/domain build && pnpm -F @home-ktv/api typecheck && pnpm -F @home-ktv/admin typecheck && pnpm -F @home-ktv/mobile-controller typecheck`

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Phase 19 is complete from an automated regression standpoint. Phase 20 can move into real-scene playback validation: NAS path mapping, file serving, byte ranges/MIME behavior, TV browser playback, and real media failure handling.

---
*Phase: 19-search-and-queue-time-catalog-sync*
*Completed: 2026-05-20*
