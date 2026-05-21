# Android TV LibVLC Spike Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a minimal Android TV playback shell that can be installed on the TV and used to verify raw NAS KTV files through libVLC.

**Architecture:** Replace the Android Studio Leanback sample browser with a single full-screen playback activity. Keep the first iteration focused on raw media URL playback and audio-track switching; API room integration comes after playback compatibility is proven.

**Tech Stack:** Kotlin, Android TV, LibVLC Android `org.videolan.android:libvlc-all:3.7.0`, JVM unit tests for pure configuration parsing.

---

### Task 1: Launch Config

**Files:**
- Create: `HomeKTV/app/src/main/java/com/liuyue/homektv/LaunchConfig.kt`
- Create: `HomeKTV/app/src/test/java/com/liuyue/homektv/LaunchConfigTest.kt`
- Modify: `HomeKTV/app/build.gradle.kts`

**Steps:**
1. Add JUnit test dependency.
2. Write a failing JVM test for default API base, room slug, and optional media URL parsing.
3. Implement minimal pure Kotlin config parsing.
4. Run `./gradlew :app:testDebugUnitTest`.

### Task 2: LibVLC Playback Shell

**Files:**
- Modify: `HomeKTV/app/build.gradle.kts`
- Modify: `HomeKTV/app/src/main/AndroidManifest.xml`
- Replace: `HomeKTV/app/src/main/java/com/liuyue/homektv/MainActivity.kt`
- Remove: template sample activities/fragments/models.

**Steps:**
1. Add `libvlc-all:3.7.0`.
2. Convert `MainActivity` to a full-screen landscape TV playback activity.
3. Attach libVLC video output to a `SurfaceView`.
4. Support launch extras/query data for `mediaUrl`, `apiBaseUrl`, and `room`.
5. Add remote keys: center/play-pause, left/right seek, up/down audio track switch.
6. Show concise Chinese status overlay.

### Task 3: Verification

**Files:**
- No production files expected.

**Steps:**
1. Run `./gradlew :app:testDebugUnitTest`.
2. Run `./gradlew :app:assembleDebug`.
3. Provide APK path and ADB install command.
4. Provide a raw media URL test command format for the TV.
