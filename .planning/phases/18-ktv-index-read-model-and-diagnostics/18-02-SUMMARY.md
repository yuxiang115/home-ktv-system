---
phase: 18-ktv-index-read-model-and-diagnostics
plan: 02
subsystem: admin
tags: [admin, diagnostics, ktv-index, react-query, postgres]

requires:
  - phase: 18-01
    provides: "Read-only KTV index repository and diagnostics contracts"
provides:
  - "GET /admin/ktv-index/diagnostics route with bounded sample and preview parameters"
  - "Admin Songs runtime query for KTV index diagnostics"
  - "Chinese-first KTV index diagnostics panel inside the existing Songs workspace"
affects: [admin-songs, ktv-index-diagnostics, operator-verification]

tech-stack:
  added:
    - "@home-ktv/domain dependency for @home-ktv/admin"
  patterns:
    - "Admin diagnostics stay inside app-local Songs runtime orchestration"
    - "React Query diagnostics key is isolated from formal catalog song list loading"
    - "Admin UI renders raw measurements without synthesized status labels"

key-files:
  created:
    - apps/api/src/routes/admin-ktv-index.ts
    - apps/api/src/test/admin-ktv-index-routes.test.ts
  modified:
    - apps/api/src/server.ts
    - apps/admin/package.json
    - pnpm-lock.yaml
    - apps/admin/src/api/client.ts
    - apps/admin/src/songs/use-song-catalog-runtime.ts
    - apps/admin/src/songs/SongCatalogView.tsx
    - apps/admin/src/i18n.tsx
    - apps/admin/src/App.css
    - apps/admin/src/test/song-catalog.test.tsx

key-decisions:
  - "KTV index diagnostics are rendered inside the existing Songs workspace, not as a new Admin tab."
  - "Admin diagnostics can show NAS file paths; Mobile-facing search remains path-safe."
  - "Refresh invalidates only the ktv-index-diagnostics query key."

patterns-established:
  - "Admin diagnostic surfaces use raw counts/tables/sample rows rather than summary status wording."
  - "KTV index search preview is debounced through the Songs runtime query state."

requirements-completed: [INDEX-01, INDEX-03, INDEX-04]

duration: 15 min
completed: 2026-05-20
---

# Phase 18 Plan 02: Admin KTV Index Diagnostics Summary

**Admin Songs now exposes raw KTV index diagnostics, NAS sample evidence, and bounded search preview from the real ktv_* read model.**

## Performance

- **Duration:** 15 min
- **Started:** 2026-05-20T09:09:00Z
- **Completed:** 2026-05-20T09:24:07Z
- **Tasks:** 3
- **Files modified:** 10

## Accomplishments

- Added `GET /admin/ktv-index/diagnostics` with bounded `q`, `sampleSize`, and `sampleTimeoutMs` parsing.
- Wired `PgKtvIndexReadRepository` into the Postgres-backed API server path.
- Added Admin client/runtime support for isolated KTV index diagnostics loading and refresh.
- Rendered a Chinese-first `KTV 索引诊断` panel inside Songs with raw metrics, table availability, parse strategy counts, NAS sample rows, and search preview.
- Added regression coverage for the API route, Admin runtime refresh, and Songs UI rendering.

## Task Commits

Each task was committed atomically:

1. **Task 1: Admin diagnostics route and server wiring** - `f13b437` (feat)
2. **Task 2: Admin client/runtime support inside Songs** - `281392d` (feat)
3. **Task 3: Render KTV index diagnostics in Songs** - `4df0630` (feat)
4. **Verification fix: complete route test mock contract** - `26ea855` (fix)

**Plan metadata:** committed separately by the GSD metadata commit.

## Files Created/Modified

- `apps/api/src/routes/admin-ktv-index.ts` - Admin diagnostics route.
- `apps/api/src/server.ts` - Postgres repository wiring and route registration.
- `apps/api/src/test/admin-ktv-index-routes.test.ts` - API route coverage.
- `apps/admin/src/api/client.ts` - `fetchKtvIndexDiagnostics`.
- `apps/admin/src/songs/use-song-catalog-runtime.ts` - Diagnostics query state and refresh orchestration.
- `apps/admin/src/songs/SongCatalogView.tsx` - KTV index diagnostics panel.
- `apps/admin/src/i18n.tsx` - Chinese and English labels.
- `apps/admin/src/App.css` - Diagnostics layout and responsive styling.
- `apps/admin/src/test/song-catalog.test.tsx` - Runtime and page rendering coverage.
- `apps/admin/package.json`, `pnpm-lock.yaml` - Admin dependency on shared domain contracts.

## Decisions Made

- The diagnostics entry stays in Songs to preserve the existing Admin IA.
- The UI shows raw metrics and sample rows only; it does not infer or label overall status.
- Admin can display diagnostic file paths because this surface is operator-facing.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added Admin dependency on shared domain package**
- **Found during:** Task 3 (Admin typecheck)
- **Issue:** Admin now imports `KtvIndexDiagnosticsResponse` directly, but `@home-ktv/domain` was not declared in `apps/admin/package.json`.
- **Fix:** Added the workspace dependency and refreshed the lockfile.
- **Files modified:** `apps/admin/package.json`, `pnpm-lock.yaml`
- **Verification:** `pnpm -F @home-ktv/domain build && pnpm -F @home-ktv/admin typecheck`
- **Committed in:** `4df0630`

**2. [Rule 1 - Bug] Completed route test repository mock**
- **Found during:** Plan verification
- **Issue:** The API route test mock implemented `getDiagnostics` but not the full `KtvIndexReadRepository` contract required by typecheck.
- **Fix:** Added a no-op `searchIndexedSongs` mock.
- **Files modified:** `apps/api/src/test/admin-ktv-index-routes.test.ts`
- **Verification:** API route test and API typecheck passed.
- **Committed in:** `26ea855`

---

**Total deviations:** 2 auto-fixed (Rule 3: 1, Rule 1: 1)
**Impact on plan:** Both fixes were required to keep the planned contracts type-safe.

## Issues Encountered

- Admin tests continue to print the existing `--localstorage-file` warning from the test environment; it did not fail the suite.

## Verification

- `pnpm -F @home-ktv/api test -- src/test/admin-ktv-index-routes.test.ts` - passed, 40 test files and 246 tests.
- `pnpm -F @home-ktv/admin test -- src/test/song-catalog.test.tsx` - passed, 7 test files and 41 tests.
- `pnpm -F @home-ktv/domain build && pnpm -F @home-ktv/api typecheck && pnpm -F @home-ktv/admin typecheck` - passed.

## User Setup Required

None - no external service configuration required for this plan.

## Next Phase Readiness

Admin can now inspect the real KTV index. Plan 18-03 can extend Mobile search with grouped indexed results while preserving the nonqueueable Phase 18 boundary.

---
*Phase: 18-ktv-index-read-model-and-diagnostics*
*Completed: 2026-05-20*
