# Room Volume Control Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a single room-level volume control from the mobile controller through API snapshots to Android TV libVLC playback.

**Architecture:** Store `volumePercent` on `playback_sessions`, expose it on room snapshots, mutate it through a new `set-volume` command, and have Android TV apply it whenever a snapshot arrives or playback starts. The mobile controller renders one debounced range slider in the current playback panel.

**Tech Stack:** TypeScript, Fastify, PostgreSQL migration SQL, React/Vite, Vitest, Android Kotlin, libVLC.

---

### Task 1: Contract And API Tests

**Files:**
- Modify: `packages/domain/src/index.ts`
- Modify: `packages/player-contracts/src/index.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `apps/api/src/test/room-queue-commands.test.ts`
- Modify: `apps/mobile-controller/src/test/controller.test.tsx`
- Modify: `HomeKTV/app/src/test/java/com/liuyue/homektv/PlayerContractsJsonTest.kt`

**Steps:**
1. Add failing tests for `set-volume`, mobile slider submission, and Android snapshot parsing.
2. Run the targeted tests and confirm the new assertions fail because the feature is not implemented.

### Task 2: API Implementation

**Files:**
- Create: `apps/api/src/db/migrations/0011_room_volume_control.sql`
- Modify: `apps/api/src/routes/control-commands.ts`
- Modify: `apps/api/src/routes/room-snapshots.ts`
- Modify: `apps/api/src/modules/rooms/build-control-snapshot.ts`
- Modify: `apps/api/src/modules/playback/session-command-service.ts`
- Modify: `apps/api/src/modules/playback/repositories/playback-session-repository.ts`

**Steps:**
1. Add `volume_percent` migration and allow `set-volume` in command history.
2. Add repository support for reading and updating volume.
3. Add route and command handling with `0-100` validation.
4. Include `volumePercent` in room snapshots and control snapshots.
5. Run API targeted tests.

### Task 3: Mobile Controller Implementation

**Files:**
- Modify: `apps/mobile-controller/src/api/client.ts`
- Modify: `apps/mobile-controller/src/runtime/use-room-controller-runtime.ts`
- Modify: `apps/mobile-controller/src/App.tsx`
- Modify: `apps/mobile-controller/src/App.css`
- Modify: `apps/mobile-controller/src/i18n.tsx`

**Steps:**
1. Add `setVolume` client helper.
2. Add debounced optimistic runtime state.
3. Render one volume slider in the current playback panel.
4. Run mobile controller targeted tests.

### Task 4: Android TV Implementation

**Files:**
- Modify: `HomeKTV/app/src/main/java/com/liuyue/homektv/PlayerContracts.kt`
- Modify: `HomeKTV/app/src/main/java/com/liuyue/homektv/PlayerContractsJson.kt`
- Modify: `HomeKTV/app/src/main/java/com/liuyue/homektv/MainActivity.kt`

**Steps:**
1. Parse `volumePercent` from snapshots with default `100`.
2. Apply clamped volume to libVLC on snapshot and before playback starts.
3. Run Android targeted unit tests.

### Task 5: Verification And Commit

**Files:**
- All changed files.

**Steps:**
1. Run targeted API, mobile, and Android tests.
2. Run typecheck/build checks where practical.
3. Review `git diff` and avoid staging unrelated dirty files.
4. Commit with a short Chinese message and push to `origin/main`.
