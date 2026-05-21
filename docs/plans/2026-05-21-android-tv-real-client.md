# Android TV Real Client Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Turn `HomeKTV` from a libVLC sample player into the real Android TV client.

**Architecture:** Keep Android UI thin. Put protocol parsing, API payload generation, audio track choice, and playback decisions in pure Kotlin classes with unit tests. `MainActivity` owns Android lifecycle, libVLC, and timers.

**Tech Stack:** Kotlin, Android Activity view code, libVLC, OkHttp WebSocket/HTTP, org.json, JUnit 4.

---

### Task 1: Protocol and Decision Tests

**Files:**
- Create: `HomeKTV/app/src/test/java/com/liuyue/homektv/PlayerContractsJsonTest.kt`
- Create: `HomeKTV/app/src/test/java/com/liuyue/homektv/RoomPlaybackDecisionTest.kt`
- Create: `HomeKTV/app/src/test/java/com/liuyue/homektv/PlayerApiPayloadsTest.kt`

**Steps:**

1. Write tests for parsing a room snapshot with `currentTarget`, `selectedTrackRef`, and next-song preview.
2. Write tests for converting a realtime `room.control.snapshot.updated` envelope into a room snapshot.
3. Write tests for deciding `play-new-target`, `keep-playing`, `stop`, and `switch-vocal-mode`.
4. Write tests for bootstrap, heartbeat, telemetry, and switch-transition JSON payloads.
5. Run `cd HomeKTV && ./gradlew :app:testDebugUnitTest --no-daemon` and verify these fail because implementation classes do not exist.

### Task 2: Pure Kotlin Runtime Layer

**Files:**
- Create: `HomeKTV/app/src/main/java/com/liuyue/homektv/PlayerContracts.kt`
- Create: `HomeKTV/app/src/main/java/com/liuyue/homektv/PlayerContractsJson.kt`
- Create: `HomeKTV/app/src/main/java/com/liuyue/homektv/RoomPlaybackDecision.kt`
- Create: `HomeKTV/app/src/main/java/com/liuyue/homektv/PlayerApiPayloads.kt`

**Steps:**

1. Implement only the fields needed by the Android TV runtime.
2. Parse optional fields defensively.
3. Keep JSON payload builders deterministic for tests.
4. Run unit tests and fix until they pass.

### Task 3: API Client and Device Identity

**Files:**
- Modify: `HomeKTV/app/build.gradle.kts`
- Modify: `HomeKTV/app/src/main/java/com/liuyue/homektv/LaunchConfig.kt`
- Create: `HomeKTV/app/src/main/java/com/liuyue/homektv/DeviceIdentity.kt`
- Create: `HomeKTV/app/src/main/java/com/liuyue/homektv/PlayerApiClient.kt`
- Modify: `HomeKTV/app/src/test/java/com/liuyue/homektv/LaunchConfigTest.kt`

**Steps:**

1. Add OkHttp.
2. Extend launch config with `deviceId` and `deviceName`.
3. Add stable Android TV device ID generation.
4. Implement bootstrap, snapshot fetch, realtime socket, heartbeat, telemetry, switch transition, and reconnect recovery calls.
5. Run unit tests.

### Task 4: MainActivity Room Mode

**Files:**
- Modify: `HomeKTV/app/src/main/java/com/liuyue/homektv/MainActivity.kt`

**Steps:**

1. Make room mode default.
2. Bootstrap and apply initial snapshot.
3. Open realtime socket and keep polling as fallback.
4. Start heartbeat every 10 seconds.
5. Play new targets with libVLC.
6. Select initial audio track when metadata appears.
7. Send loading, playing, ended, failed, and switch telemetry.
8. Keep sample mode reachable for diagnostics.

### Task 5: Verification and Commit

**Commands:**

```bash
cd HomeKTV
./gradlew :app:testDebugUnitTest :app:assembleDebug --no-daemon
```

Then commit only Android TV real-client files and push to `main`.
