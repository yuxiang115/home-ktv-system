package com.liuyue.homektv

import org.junit.Assert.assertEquals
import org.junit.Test

class AudioTrackUiStateTest {
    @Test
    fun describesNullTracksAsNotLoaded() {
        val label = describeAudioTrackState(
            rawTracks = null,
            currentTrackId = -1,
        )

        assertEquals("音轨未加载", label)
    }

    @Test
    fun filtersDisabledTrackAndShowsCurrentTrack() {
        val label = describeAudioTrackState(
            rawTracks = listOf(
                AudioTrackOption(id = -1, name = "Disable"),
                AudioTrackOption(id = 2, name = "原唱"),
                AudioTrackOption(id = 3, name = "伴唱"),
            ),
            currentTrackId = 3,
        )

        assertEquals("音轨 2/2 · 伴唱", label)
    }
}
