package com.liuyue.homektv

import org.junit.Assert.assertEquals
import org.junit.Test

class PlaybackHudStateTest {
    @Test
    fun mapsPlayingStatusToPlayingLabel() {
        assertEquals("播放中", playbackStateLabelForStatus("正在播放 · 原唱", roomModeActive = true))
    }

    @Test
    fun keepsPlayingLabelDuringAudioTrackRefreshEvenWhenRuntimeFlagIsLate() {
        val label = playbackStateLabelForRefresh(
            currentLabel = "播放中",
            roomModeActive = true,
            hasActiveTarget = true,
            hasCurrentMedia = true,
            isPlayerPlaying = false,
        )

        assertEquals("播放中", label)
    }

    @Test
    fun derivesPreparingLabelBeforePlaybackStarts() {
        val label = playbackStateLabelForRefresh(
            currentLabel = "",
            roomModeActive = true,
            hasActiveTarget = true,
            hasCurrentMedia = true,
            isPlayerPlaying = false,
        )

        assertEquals("准备中", label)
    }
}
