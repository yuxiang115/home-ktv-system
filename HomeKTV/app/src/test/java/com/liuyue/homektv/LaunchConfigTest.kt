package com.liuyue.homektv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LaunchConfigTest {
    @Test
    fun usesDefaultsWhenLaunchValuesAreBlank() {
        val config = LaunchConfig.from(
            rawApiBaseUrl = null,
            rawRoom = "",
            rawMediaUrl = "   ",
        )

        assertEquals("http://192.168.5.64:4000", config.apiBaseUrl)
        assertEquals("living-room", config.roomSlug)
        assertNull(config.mediaUrl)
    }

    @Test
    fun trimsExplicitLaunchValues() {
        val config = LaunchConfig.from(
            rawApiBaseUrl = " http://192.168.5.64:4000/ ",
            rawRoom = " living-room ",
            rawMediaUrl = " http://192.168.5.64:4000/media/raw/sample.mkv ",
        )

        assertEquals("http://192.168.5.64:4000", config.apiBaseUrl)
        assertEquals("living-room", config.roomSlug)
        assertEquals("http://192.168.5.64:4000/media/raw/sample.mkv", config.mediaUrl)
    }
}
