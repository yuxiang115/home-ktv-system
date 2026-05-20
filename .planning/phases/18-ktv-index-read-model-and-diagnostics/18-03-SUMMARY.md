---
phase: 18-ktv-index-read-model-and-diagnostics
plan: 03
subsystem: search-ui
tags: [react, fastify, postgres, mobile-search, ktv-index]

requires:
  - phase: 18-01
    provides: KTV index read repository and shared indexed search contracts
  - phase: 18-02
    provides: Admin Songs diagnostics surface and route wiring
provides:
  - Required indexed section on Mobile song search responses
  - Mobile rendering for grouped KTV indexed song results and version rows
  - Regression coverage for path-safe indexed search and nonqueueable Phase 18 buttons
affects: [phase-19, mobile-controller, song-search, admin-songs]

tech-stack:
  added: []
  patterns:
    - Existing Mobile search panel extended with source-labeled indexed sections
    - API-authored disabled indexed queue state preserved until queue-time sync

key-files:
  created:
    - .planning/phases/18-ktv-index-read-model-and-diagnostics/18-03-SUMMARY.md
  modified:
    - packages/domain/src/index.ts
    - apps/api/src/routes/song-search.ts
    - apps/api/src/server.ts
    - apps/api/src/test/song-search-routes.test.ts
    - apps/mobile-controller/src/App.tsx
    - apps/mobile-controller/src/App.css
    - apps/mobile-controller/src/i18n.tsx
    - apps/mobile-controller/src/test/controller.test.tsx
    - apps/admin/src/test/song-catalog.test.tsx

key-decisions:
  - "SongSearchResponse.indexed is required so Mobile can consistently render formal, indexed, and online result sections."
  - "Indexed Mobile versions remain disabled with queueState=needs_catalog_sync and label 需同步入库后可点歌 until Phase 19 adds catalog sync."
  - "Mobile search renders source/category/version metadata but never absolute NAS paths; Admin diagnostics remains the path-visible operator surface."

patterns-established:
  - "Search response carries indexed song/asset identity for Phase 19 without sending those IDs to queue commands in Phase 18."
  - "Mobile indexed rows use disabled primary buttons without onClick handlers, keeping unavailable real-library results visible but safe."

requirements-completed: [INDEX-02, INDEX-03, INDEX-04]

duration: 17 min
completed: 2026-05-20
---

# Phase 18 Plan 03: Search Response Source Labeling and Regression Coverage Summary

**Mobile search now shows grouped KTV indexed results from the existing search endpoint while keeping indexed versions visibly disabled and path-safe.**

## Performance

- **Duration:** 17 min
- **Started:** 2026-05-20T09:25:16Z
- **Completed:** 2026-05-20T09:42:08Z
- **Tasks:** 3
- **Files modified:** 9

## Accomplishments

- Extended `/rooms/:roomSlug/songs/search` so responses include `local`, `indexed`, and `online` sections.
- Wired PostgreSQL runtime search to `KtvIndexReadRepository.searchIndexedSongs` with bounded limit and `versionsPerSong: 4`.
- Rendered KTV indexed song groups in Mobile with source labels, version metadata, file-size display, and disabled queue buttons.
- Added cross-surface regression coverage across API, Mobile, and Admin Songs diagnostics.

## Task Commits

1. **Task 1: Extend the Mobile search route with indexed results** - `ffaa9a1` (test RED), `4020a4d` (feat GREEN)
2. **Task 2: Render indexed search groups in Mobile** - `1933785` (test RED), `f578a10` (feat GREEN)
3. **Task 3: Add cross-surface regression and typecheck coverage** - `3d24434` (test)

## Files Created/Modified

- `packages/domain/src/index.ts` - Requires `SongSearchResponse.indexed`.
- `apps/api/src/routes/song-search.ts` - Calls indexed repository and serializes indexed search section.
- `apps/api/src/server.ts` - Passes the KTV index repository to song search in PostgreSQL mode.
- `apps/api/src/test/song-search-routes.test.ts` - Covers indexed response shape, bounded repository calls, local asset preservation, and path-safe JSON.
- `apps/mobile-controller/src/App.tsx` - Renders indexed song groups and disabled indexed version buttons.
- `apps/mobile-controller/src/App.css` - Adds responsive indexed panel and version-row styling.
- `apps/mobile-controller/src/i18n.tsx` - Adds Chinese/English indexed search labels.
- `apps/mobile-controller/src/test/controller.test.tsx` - Covers Mobile indexed rendering and disabled queue action behavior.
- `apps/admin/src/test/song-catalog.test.tsx` - Strengthens Admin Songs diagnostics regression assertions.

## Decisions Made

- `indexed` is a required response section, with no-repository and no-result cases represented as `status: "unavailable"` and `results: []`.
- Indexed search identity is preserved in response state (`indexedSongId`, `indexedAssetId`) for Phase 19, but Phase 18 never sends it to queue commands.
- Mobile displays `KTV索引`, category, extension, and size only; absolute filesystem paths remain absent from Mobile UI.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- Mobile typecheck needed `pnpm -F @home-ktv/domain build` first because the shared domain type output was stale after adding `SongSearchResponse.indexed`.
- One Admin regression assertion initially matched two language selectors; the test was narrowed to assert presence rather than uniqueness.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Phase 19 can now turn indexed versions into queueable actions by syncing selected `indexedAssetId` rows into canonical `songs/assets` before queue insertion.

---
*Phase: 18-ktv-index-read-model-and-diagnostics*
*Completed: 2026-05-20*
