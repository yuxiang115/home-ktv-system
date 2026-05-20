---
phase: 19-search-and-queue-time-catalog-sync
plan: 01
subsystem: mobile-api
tags: [mobile-controller, song-search, ktv-index, queue]

requires:
  - phase: 18-ktv-index-read-model-and-diagnostics
    provides: Read-only KTV indexed search results and diagnostics preview
provides:
  - Queueable indexed search states for Mobile search results
  - Mobile indexed queue command payload using indexedAssetId only
  - Inline Mobile pending, queued, stale, and unreadable indexed button states
affects: [19-02, 19-03, 19-04, mobile-controller, song-search]

tech-stack:
  added: []
  patterns:
    - Server-authored indexed queue state drives Mobile rendering
    - Mobile indexed queue requests send source identity only, without NAS paths or metadata

key-files:
  created:
    - .planning/phases/19-search-and-queue-time-catalog-sync/19-01-SUMMARY.md
  modified:
    - packages/domain/src/index.ts
    - apps/api/src/modules/ktv-index/ktv-index-read-repository.ts
    - apps/api/src/routes/song-search.ts
    - apps/api/src/test/song-search-routes.test.ts
    - apps/api/src/test/ktv-index-read-repository.test.ts
    - apps/mobile-controller/src/api/client.ts
    - apps/mobile-controller/src/runtime/use-room-controller-runtime.ts
    - apps/mobile-controller/src/App.tsx
    - apps/mobile-controller/src/App.css
    - apps/mobile-controller/src/i18n.tsx
    - apps/mobile-controller/src/test/controller.test.tsx

key-decisions:
  - "Indexed search versions are queueable by default until later queue-time sync marks them stale or unreadable."
  - "Mobile duplicate confirmation is now a canonical/indexed union so queued indexed results can reuse the existing modal."

patterns-established:
  - "Indexed queue buttons derive labels from queueState, canQueue, disabledLabel, and pendingIndexedAssetId."
  - "KTV indexed Mobile requests include indexedAssetId only; songId, assetId, NAS paths, and raw source metadata stay server-side."

requirements-completed: [SYNC-01, SYNC-04]

duration: 10 min
completed: 2026-05-20
---

# Phase 19 Plan 01: Indexed Search Queue State Summary

**Mobile search can now present KTV indexed versions as direct 点歌 targets while preserving server-owned queue state and hiding NAS paths.**

## Performance

- **Duration:** 10 min
- **Started:** 2026-05-20T11:48:00Z
- **Completed:** 2026-05-20T11:58:29Z
- **Tasks:** 2
- **Files modified:** 11

## Accomplishments

- Replaced the old `needs_catalog_sync` indexed state with `not_queued`, `queued`, `source_missing`, and `file_unreadable`.
- Updated KTV index search mapping so active results are queueable, queued inputs show `已点`, and unreadable inputs show `文件不可读`.
- Added Mobile `indexedAssetId` queue payloads, inline `正在加入...`, duplicate confirmation for queued indexed items, and stable indexed version buttons.

## Task Commits

1. **Task 1 + Task 2: Indexed search states and Mobile queue actions** - `b01732f` (feat)

## Files Created/Modified

- `packages/domain/src/index.ts` - Shared indexed queue-state contract.
- `apps/api/src/modules/ktv-index/ktv-index-read-repository.ts` - Indexed queue-state mapping from queued/unreadable inputs.
- `apps/api/src/routes/song-search.ts` - Search route passes placeholder indexed state inputs for later source identity wiring.
- `apps/mobile-controller/src/api/client.ts` - `addQueueEntry` accepts canonical IDs or `indexedAssetId`.
- `apps/mobile-controller/src/runtime/use-room-controller-runtime.ts` - Indexed pending state, duplicate-confirm union, and post-add refresh/search rerun.
- `apps/mobile-controller/src/App.tsx` / `App.css` / `i18n.tsx` - Indexed 点歌, 正在加入, 已点, 索引已失效, 文件不可读 rendering.
- `apps/api/src/test/*` and `apps/mobile-controller/src/test/controller.test.tsx` - Regression coverage for API and Mobile behavior.

## Decisions Made

- Indexed active assets are queueable at the search-contract layer; real sync and queue-time validation are introduced in later plans.
- Mobile keeps indexed results in the KTV index section after queue attempts instead of moving them into local results.
- Duplicate confirmation stores a discriminated union so canonical and indexed add-again flows remain explicit.

## Deviations from Plan

None - plan executed exactly as written.

**Total deviations:** 0 auto-fixed.  
**Impact on plan:** No scope change.

## Issues Encountered

- Mobile typecheck initially read stale `@home-ktv/domain` dist declarations; rebuilt `@home-ktv/domain` before rerunning typecheck successfully.

## Verification

- `pnpm -F @home-ktv/api test -- src/test/song-search-routes.test.ts src/test/ktv-index-read-repository.test.ts`
- `pnpm -F @home-ktv/mobile-controller test -- src/test/controller.test.tsx`
- `pnpm -F @home-ktv/domain build`
- `pnpm -F @home-ktv/mobile-controller typecheck`

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Ready for 19-02. The Mobile/API search contract now has the fields needed for queue-time catalog sync and later source identity mapping.

---
*Phase: 19-search-and-queue-time-catalog-sync*
*Completed: 2026-05-20*
