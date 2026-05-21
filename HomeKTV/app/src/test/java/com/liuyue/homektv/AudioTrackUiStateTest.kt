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

    @Test
    fun choosesTrackByNumericHexIdFirst() {
        val track = chooseAudioTrackForRef(
            tracks = listOf(
                AudioTrackOption(id = 1, name = "Track A"),
                AudioTrackOption(id = 2, name = "Track B"),
            ),
            trackRef = TrackRef(index = 1, id = "0x2", label = "Original"),
        )

        assertEquals(2, track?.id)
    }

    @Test
    fun treatsPositiveProbeIndexAsStreamIndexWhenIdDoesNotMatch() {
        val track = chooseAudioTrackForRef(
            tracks = listOf(
                AudioTrackOption(id = 20, name = "Track A"),
                AudioTrackOption(id = 21, name = "Track B"),
            ),
            trackRef = TrackRef(index = 2, id = "0x3", label = "Instrumental"),
        )

        assertEquals(21, track?.id)
    }
}
