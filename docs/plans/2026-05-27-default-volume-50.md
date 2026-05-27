# Default Volume 50 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Change HomeKTV room volume default to 50 while keeping the controller range at 0-100 and making Web TV apply snapshot volume to real playback.

**Architecture:** Introduce one shared `DEFAULT_ROOM_VOLUME_PERCENT` contract in `@home-ktv/player-contracts` and replace scattered `100` fallbacks. API snapshots, playback-session row mapping, controller runtime fallback, Android snapshot parsing, and Web TV playback use this default. Add an idempotent DB migration to alter the column default and reset untouched 100-percent sessions to 50.

**Tech Stack:** TypeScript, React/Vite, Fastify, PostgreSQL SQL migrations, Vitest, Android Kotlin/JUnit, libVLC.

---

### Task 1: Red Tests For Default Volume

**Files:**
- Modify: `apps/api/src/test/room-queue-commands.test.ts`
- Modify: `apps/controller/src/test/controller.test.tsx`
- Modify: `apps/tv-web/src/test/active-playback-controller.test.tsx`
- Modify: `clients/android-tv/app/src/test/java/com/liuyue/homektv/PlayerContractsJsonTest.kt`

**Steps:**
1. Add tests that expect missing/implicit volume to resolve to 50.
2. Add a Web TV test that expects `ensurePlaying` to apply `snapshot.volumePercent` to `activeVideo.volume`.
3. Run targeted tests and confirm they fail against current code.

### Task 2: Shared Default And API

**Files:**
- Modify: `packages/player-contracts/src/index.ts`
- Modify: `apps/api/src/routes/room-snapshots.ts`
- Modify: `apps/api/src/modules/rooms/build-control-snapshot.ts`
- Modify: `apps/api/src/modules/playback/repositories/playback-session-repository.ts`
- Modify: `apps/api/src/test/room-queue-commands.test.ts`
- Create: `apps/api/src/db/migrations/0012_default_room_volume_50.sql`

**Steps:**
1. Export `DEFAULT_ROOM_VOLUME_PERCENT = 50`.
2. Replace API fallback `100` values with the shared default.
3. Add the migration for the PostgreSQL column default and untouched current sessions.
4. Run targeted API tests.

### Task 3: Controller And Web TV

**Files:**
- Modify: `apps/controller/src/runtime/use-room-controller-runtime.ts`
- Modify: `apps/controller/src/test/controller.test.tsx`
- Modify: `apps/tv-web/src/runtime/video-pool.ts`
- Modify: `apps/tv-web/src/runtime/active-playback-controller.ts`
- Modify: `apps/tv-web/src/test/active-playback-controller.test.tsx`

**Steps:**
1. Use the shared default in controller fallback and normalization.
2. Add `volume` to `KtvVideoElement`.
3. Apply snapshot volume to active and standby video elements before playback starts.
4. Run targeted controller and Web TV tests.

### Task 4: Android TV

**Files:**
- Modify: `clients/android-tv/app/src/main/java/com/liuyue/homektv/PlayerContracts.kt`
- Modify: `clients/android-tv/app/src/main/java/com/liuyue/homektv/PlayerContractsJson.kt`
- Modify: `clients/android-tv/app/src/main/java/com/liuyue/homektv/MainActivity.kt`
- Modify: `clients/android-tv/app/src/test/java/com/liuyue/homektv/PlayerContractsJsonTest.kt`

**Steps:**
1. Change Android default volume constants/fallbacks from 100 to 50.
2. Run Android targeted tests.

### Task 5: Verification, Commit, Deploy

**Files:**
- All changed files.

**Steps:**
1. Run targeted tests for API, controller, Web TV, and Android.
2. Run relevant typechecks/builds.
3. Review diff and stage only intended files.
4. Commit with a short Chinese message and push.
5. Deploy on `lxc-dev` with `git pull`, `deploy/docker/ktv.sh restart`, and `deploy/docker/ktv.sh doctor`.
