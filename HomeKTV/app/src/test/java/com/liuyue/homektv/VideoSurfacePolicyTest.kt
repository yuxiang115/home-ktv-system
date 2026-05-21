package com.liuyue.homektv

import org.junit.Assert.assertEquals
import org.junit.Test
import org.videolan.libvlc.MediaPlayer

class VideoSurfacePolicyTest {
    @Test
    fun usesAspectPreservingBestFitByDefault() {
        assertEquals(MediaPlayer.ScaleType.SURFACE_BEST_FIT, VideoSurfacePolicy.defaultScaleType)
    }
}
