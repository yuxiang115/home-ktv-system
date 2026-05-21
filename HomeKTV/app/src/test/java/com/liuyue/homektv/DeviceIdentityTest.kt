package com.liuyue.homektv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceIdentityTest {
    @Test
    fun explicitLaunchDeviceIdWinsWithoutPersistence() {
        val resolved = DeviceIdentity.resolve(
            explicitDeviceId = " android-tv-explicit ",
            storedDeviceId = "android-tv-stored",
            generatedDeviceId = { "android-tv-new" },
        )

        assertEquals("android-tv-explicit", resolved.deviceId)
        assertFalse(resolved.shouldPersist)
    }

    @Test
    fun storedDeviceIdWinsBeforeGeneratingNewOne() {
        val resolved = DeviceIdentity.resolve(
            explicitDeviceId = null,
            storedDeviceId = " android-tv-stored ",
            generatedDeviceId = { "android-tv-new" },
        )

        assertEquals("android-tv-stored", resolved.deviceId)
        assertFalse(resolved.shouldPersist)
    }

    @Test
    fun generatedDeviceIdIsPersistedWhenNoExistingIdExists() {
        val resolved = DeviceIdentity.resolve(
            explicitDeviceId = " ",
            storedDeviceId = null,
            generatedDeviceId = { "android-tv-new" },
        )

        assertEquals("android-tv-new", resolved.deviceId)
        assertTrue(resolved.shouldPersist)
    }
}
