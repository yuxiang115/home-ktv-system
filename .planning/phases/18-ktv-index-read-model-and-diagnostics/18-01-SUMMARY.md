---
phase: 18-ktv-index-read-model-and-diagnostics
plan: 01
subsystem: api
tags: [postgres, ktv-index, diagnostics, search, nas-sampling]

requires:
  - phase: 17
    provides: "v1.2 real MV catalog/index groundwork and durable media contracts"
provides:
  - "Shared domain contracts for KTV indexed search and raw diagnostics"
  - "Read-only PostgreSQL repository over ktv_* tables"
  - "Bounded NAS readability sampling with unmapped/missing/unreadable/timeout buckets"
affects: [admin-diagnostics, mobile-search, ktv-index, real-library-verification]

tech-stack:
  added: []
  patterns:
    - "Read-only ktv_* repository with active-asset filtering"
    - "Mobile-safe indexed search versions separate from Admin diagnostic preview"
    - "Bounded filesystem sampling instead of full NAS scans"

key-files:
  created:
    - apps/api/src/modules/ktv-index/ktv-index-diagnostics.ts
  modified:
    - packages/domain/src/index.ts
    - apps/api/src/modules/ktv-index/ktv-index-read-repository.ts
    - apps/api/src/test/ktv-index-read-repository.test.ts

key-decisions:
  - "Phase 18 indexed results remain nonqueueable with queueState=needs_catalog_sync."
  - "Mobile-facing indexed search omits filePath; Admin diagnostics preview includes it."
  - "NAS diagnostics classify unmapped paths separately from missing/unreadable/timeout."

patterns-established:
  - "KTV index read model uses parameterized SELECT queries only and filters missing_at IS NULL for active assets."
  - "Diagnostics expose raw metrics without synthesized health labels."

requirements-completed: [INDEX-01, INDEX-02, INDEX-03, INDEX-04]

duration: 12 min
completed: 2026-05-20
---

# Phase 18 Plan 01: KTV Index Read Model and Diagnostics Summary

**Read-only KTV index search and raw diagnostics contracts over ktv_* tables, with bounded NAS sample checks.**

## Performance

- **Duration:** 12 min
- **Started:** 2026-05-20T08:56:29Z
- **Completed:** 2026-05-20T09:08:09Z
- **Tasks:** 3
- **Files modified:** 4

## Accomplishments

- Added shared indexed-search and diagnostics response types, including grouped indexed results and Admin preview versions.
- Added `PgKtvIndexReadRepository` for bounded, active-only search over `ktv_songs`, `ktv_song_assets`, `ktv_song_artists`, and `ktv_artists`.
- Added raw diagnostic reads for table availability, latest run, asset/song/artist counts, parse strategies, confidence metrics, and preview rows.
- Added bounded NAS readability sampling with separate `readable`, `missing`, `unreadable`, `timeout`, and `unmapped` counts.

## Task Commits

Each task was committed atomically:

1. **Task 1: Shared KTV indexed search and diagnostics contracts** - `23898e5` (feat)
2. **Task 2: Read-only KTV index repository** - `d2c610f` (feat)
3. **Task 3: Bounded NAS readability sampling** - `7ae68aa` (feat)

**Plan metadata:** committed separately by the GSD metadata commit.

## Files Created/Modified

- `packages/domain/src/index.ts` - Shared indexed-search and raw diagnostics contracts.
- `apps/api/src/modules/ktv-index/ktv-index-read-repository.ts` - Read-only Postgres repository for indexed search and diagnostics.
- `apps/api/src/modules/ktv-index/ktv-index-diagnostics.ts` - Timeout-safe NAS sample classifier.
- `apps/api/src/test/ktv-index-read-repository.test.ts` - Coverage for active-only search, Admin-only preview details, and NAS sample buckets.

## Decisions Made

- Indexed search versions are visible but not queueable in Phase 18; queue/playback integration remains a later plan.
- Search results preserve `indexedSongId` and `indexedAssetId`, but Mobile-facing data does not expose NAS paths.
- Diagnostics report raw measurements only; status interpretation stays out of the contract.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Corrected indexed asset category source**
- **Found during:** Task 2 (read-only repository)
- **Issue:** The initial SQL shape referenced an asset category field that does not exist on `ktv_song_assets`.
- **Fix:** Returned the song category from the matched song CTE for indexed version display.
- **Files modified:** `apps/api/src/modules/ktv-index/ktv-index-read-repository.ts`
- **Verification:** Repository test and API typecheck passed.
- **Committed in:** `d2c610f`

**2. [Rule 3 - Blocking] Omitted undefined optional timeout**
- **Found during:** Task 3 (NAS sampling)
- **Issue:** `exactOptionalPropertyTypes` rejects passing `timeoutMs: undefined` to an optional property.
- **Fix:** Only include `timeoutMs` in the `buildNasSample` input when a value is provided.
- **Files modified:** `apps/api/src/modules/ktv-index/ktv-index-read-repository.ts`
- **Verification:** API typecheck passed after rebuilding `@home-ktv/domain`.
- **Committed in:** `7ae68aa`

---

**Total deviations:** 2 auto-fixed (Rule 1: 1, Rule 3: 1)
**Impact on plan:** Both fixes preserved the planned behavior and tightened correctness.

## Issues Encountered

- API typecheck reads `@home-ktv/domain` types from the ignored local `packages/domain/dist` output. Verification used `pnpm -F @home-ktv/domain build && pnpm -F @home-ktv/api typecheck`.

## Verification

- `pnpm -F @home-ktv/api test -- src/test/ktv-index-read-repository.test.ts` - passed, 39 test files and 245 tests.
- `pnpm -F @home-ktv/domain build && pnpm -F @home-ktv/api typecheck` - passed.

## User Setup Required

None - no external service configuration required for this plan.

## Next Phase Readiness

The backend read model is ready for Plan 18-02 to expose diagnostics through Admin Songs and for Plan 18-03 to extend Mobile search with indexed candidates.

---
*Phase: 18-ktv-index-read-model-and-diagnostics*
*Completed: 2026-05-20*
