package com.liuyue.homektv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DemoSamplePlaylistTest {
    @Test
    fun containsThirtySamplesForManualSweep() {
        assertEquals(30, DemoSamplePlaylist.samples.size)
    }

    @Test
    fun buildsRawMediaUrlFromApiBaseUrl() {
        val sample = DemoSamplePlaylist.samples.first()

        assertEquals(
            "http://192.168.5.64:4000/media/ktv-index/${sample.indexedAssetId}/raw",
            sample.rawUrl("http://192.168.5.64:4000/"),
        )
    }

    @Test
    fun wrapsNextSampleIndex() {
        assertEquals(0, DemoSamplePlaylist.nextIndex(29))
        assertEquals(1, DemoSamplePlaylist.nextIndex(0))
    }

    @Test
    fun selectedSamplesCoverMainCodecBuckets() {
        val signatures = DemoSamplePlaylist.samples.map { "${it.extension}|${it.videoCodec}|${it.audioCodecs}" }

        assertTrue(signatures.any { it.startsWith(".mpg|mpeg2video|mp2") })
        assertTrue(signatures.any { it.startsWith(".mkv|h264|mp2") })
        assertTrue(signatures.any { it.startsWith(".mkv|rv40|aac") })
    }
}
