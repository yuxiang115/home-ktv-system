package com.liuyue.homektv

import java.util.UUID

data class ResolvedDeviceIdentity(
    val deviceId: String,
    val shouldPersist: Boolean,
)

object DeviceIdentity {
    fun resolve(
        explicitDeviceId: String?,
        storedDeviceId: String?,
        generatedDeviceId: () -> String = { "android-tv-${UUID.randomUUID()}" },
    ): ResolvedDeviceIdentity {
        val explicit = explicitDeviceId.cleanValue()
        if (explicit != null) {
            return ResolvedDeviceIdentity(deviceId = explicit, shouldPersist = false)
        }

        val stored = storedDeviceId.cleanValue()
        if (stored != null) {
            return ResolvedDeviceIdentity(deviceId = stored, shouldPersist = false)
        }

        return ResolvedDeviceIdentity(deviceId = generatedDeviceId().trim(), shouldPersist = true)
    }

    private fun String?.cleanValue(): String? {
        val value = this?.trim()
        return value?.takeIf { it.isNotEmpty() }
    }
}
