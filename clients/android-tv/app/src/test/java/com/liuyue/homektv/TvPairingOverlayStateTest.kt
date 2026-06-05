package com.liuyue.homektv

import org.junit.Assert.assertEquals
import org.junit.Test

class TvPairingOverlayStateTest {
    @Test
    fun idleRoomShowsLargeQrAndHidesPlaybackHud() {
        val state = TvPairingOverlayState.from(
            roomModeActive = true,
            snapshot = snapshot(currentTarget = null),
        )

        assertEquals(true, state.showIdlePairing)
        assertEquals(true, state.showIdleBackground)
        assertEquals(false, state.showPlayingQr)
        assertEquals(false, state.showPlaybackHud)
        assertEquals("http://controller.local/controller", state.qrPayload)
    }

    @Test
    fun playingRoomShowsSmallQrAndPlaybackHud() {
        val state = TvPairingOverlayState.from(
            roomModeActive = true,
            snapshot = snapshot(currentTarget = target()),
        )

        assertEquals(false, state.showIdlePairing)
        assertEquals(false, state.showIdleBackground)
        assertEquals(true, state.showPlayingQr)
        assertEquals(true, state.showPlaybackHud)
        assertEquals("http://controller.local/controller", state.qrPayload)
    }

    @Test
    fun nonRoomPlaybackHidesPairingQrButKeepsHud() {
        val state = TvPairingOverlayState.from(
            roomModeActive = false,
            snapshot = null,
        )

        assertEquals(false, state.showIdlePairing)
        assertEquals(false, state.showIdleBackground)
        assertEquals(false, state.showPlayingQr)
        assertEquals(true, state.showPlaybackHud)
        assertEquals(null, state.qrPayload)
    }

    private fun snapshot(currentTarget: PlaybackTarget?): RoomSnapshot {
        return RoomSnapshot(
            roomSlug = "living-room",
            sessionVersion = 1,
            state = if (currentTarget == null) "idle" else "playing",
            pairing = PairingInfo(
                roomSlug = "living-room",
                controllerUrl = "http://controller.local/controller",
                qrPayload = "http://controller.local/controller",
                token = "token",
                tokenExpiresAt = "2026-05-22T00:00:00.000Z",
            ),
            currentTarget = currentTarget,
            switchTarget = null,
            targetVocalMode = currentTarget?.vocalMode,
            conflict = false,
            noticeMessage = null,
            generatedAt = "2026-05-21T00:00:00.000Z",
        )
    }

    private fun target(): PlaybackTarget {
        return PlaybackTarget(
            roomId = "room-1",
            sessionVersion = 1,
            queueEntryId = "queue-1",
            sourceType = "nas",
            songId = "song-1",
            assetId = "asset-1",
            currentQueueEntryPreview = QueueEntryPreview("queue-1", "稻香", "周杰伦"),
            playbackUrl = "http://api.local/media/asset-1/raw",
            resumePositionMs = 0L,
            vocalMode = "instrumental",
            switchFamily = "real-mv-audio-track",
            playbackProfile = null,
            selectedTrackRef = null,
            nextQueueEntryPreview = null,
        )
    }
}
