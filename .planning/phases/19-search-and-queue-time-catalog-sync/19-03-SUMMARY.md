---
phase: 19-search-and-queue-time-catalog-sync
plan: 03
subsystem: api-playback
tags: [postgres, queue, ktv-index, catalog-sync, realtime]

requires:
  - phase: 19-search-and-queue-time-catalog-sync
    provides: Idempotent selected indexed asset to canonical catalog sync
provides:
  - Indexed add-queue-entry command payload support
  - Transaction coordinator for queue-time KTV catalog sync plus queue append
  - Canonical-only queue entry persistence for synced indexed assets
  - KTV-index queue admission exception without claiming playback switching support
affects: [19-04, mobile-search, playback-commands, realtime-snapshots, ktv-index]

tech-stack:
  added: []
  patterns:
    - PostgreSQL runtime repositories can be created over either a pool or transaction client
    - Indexed queue admission composes catalog sync and room command execution in one transaction

key-files:
  created:
    - apps/api/src/runtime/pg-runtime-repositories.ts
    - apps/api/src/modules/playback/indexed-queue-command-service.ts
    - .planning/phases/19-search-and-queue-time-catalog-sync/19-03-SUMMARY.md
  modified:
    - apps/api/src/server.ts
    - apps/api/src/routes/control-commands.ts
    - apps/api/src/modules/playback/session-command-service.ts
    - apps/api/src/test/indexed-queue-command.test.ts

key-decisions:
  - "Indexed add-queue-entry sync and canonical queue append run inside one PostgreSQL transaction."
  - "Client payloads must choose exactly one queue source: canonical songId/assetId or indexedAssetId."
  - "KTV-index-synced real MV assets may enter the queue without claiming audio-track switching support."

patterns-established:
  - "Queue-time coordinators receive a transaction-bound QueryExecutor and build the same runtime repository bundle used by normal PostgreSQL startup."
  - "queue_entries remains canonical-only; ktv_* identity is preserved in source_records and request context, not persisted on queue rows."

requirements-completed: [SYNC-01, SYNC-02, SYNC-04]

duration: 12 min
completed: 2026-05-20
---

# Phase 19 Plan 03: Queue Command Integration Summary

**Mobile indexed queue requests now atomically sync selected KTV index assets into canonical catalog rows before appending canonical queue entries.**

## Performance

- **Duration:** 12 min
- **Started:** 2026-05-20T12:17:41Z
- **Completed:** 2026-05-20T12:28:29Z
- **Tasks:** 3
- **Files modified:** 6

## Accomplishments

- Extracted the PostgreSQL runtime repository bundle so normal startup and transaction-bound command execution use the same repository construction.
- Added `PgIndexedQueueCommandService` to wrap room lookup, control-session restore, KTV catalog sync, queue command execution, commit, rollback, and stable rejected error mapping.
- Extended `/rooms/:roomSlug/commands/add-queue-entry` to accept `indexedAssetId`, reject mixed queue sources, and broadcast accepted indexed snapshots like canonical commands.
- Allowed KTV-index-synced real MV assets into the queue while preserving canonical queue row ids and keeping audio-track switching unavailable until runtime support is proven.

## Task Commits

1. **Task 1: Extract transaction-capable PostgreSQL repository factory** - `2b94aaf` (refactor)
2. **Task 2: Add indexed add-queue-entry transaction coordinator** - `e10dfe0` (feat)
3. **Task 3: Allow KTV-index-synced real MV queue admission** - `e6b718a` (feat)

## Files Created/Modified

- `apps/api/src/runtime/pg-runtime-repositories.ts` - Shared PostgreSQL runtime repository factory for pool and transaction clients.
- `apps/api/src/modules/playback/indexed-queue-command-service.ts` - Transaction coordinator for indexed sync plus canonical queue command execution.
- `apps/api/src/server.ts` - Wires shared repository factory and indexed queue command service into PostgreSQL runtime startup.
- `apps/api/src/routes/control-commands.ts` - Adds indexed payload validation, unavailable-service handling, and accepted indexed command broadcast flow.
- `apps/api/src/modules/playback/session-command-service.ts` - Adds the narrow KTV-index admission branch for synced real MV assets.
- `apps/api/src/test/indexed-queue-command.test.ts` - Covers route validation, transaction order, error mapping, rollback, repository factory, and canonical queue persistence.

## Decisions Made

- Indexed sync and queue insertion share one PostgreSQL transaction so a failed queue command cannot leave a partially synced queue-visible mutation.
- Mixed canonical/indexed queue payloads are rejected before command execution to keep client intent unambiguous.
- KTV-index real MV admission is limited to queueability; playback switching still requires a valid switch target and remains blocked when track roles are missing.

## Deviations from Plan

None - plan executed exactly as written.

**Total deviations:** 0 auto-fixed.  
**Impact on plan:** No scope change.

## Issues Encountered

None.

## Verification

- `pnpm -F @home-ktv/api test -- src/test/indexed-queue-command.test.ts src/test/real-mv-playback-flow.test.ts`
- `pnpm -F @home-ktv/api typecheck`

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Ready for 19-04. Indexed queue commands now produce canonical queue rows, so the final plan can verify queued search state, realtime snapshots, Admin source traceability, and cross-package regression coverage.

---
*Phase: 19-search-and-queue-time-catalog-sync*
*Completed: 2026-05-20*
