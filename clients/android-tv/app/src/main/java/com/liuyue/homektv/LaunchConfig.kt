package com.liuyue.homektv

data class LaunchConfig(
    val apiBaseUrl: String,
    val roomSlug: String,
    val mediaUrl: String?,
    val deviceId: String?,
    val deviceName: String,
) {
    companion object {
        private const val DEFAULT_API_BASE_URL = "https://ktv-api.shaolongfei.com"
        private const val DEFAULT_ROOM_SLUG = "living-room"
        private const val DEFAULT_DEVICE_NAME = "HomeKTV Android TV"

        fun from(
            rawApiBaseUrl: String?,
            rawRoom: String?,
            rawMediaUrl: String?,
            rawDeviceId: String? = null,
            rawDeviceName: String? = null,
        ): LaunchConfig {
            return LaunchConfig(
                apiBaseUrl = rawApiBaseUrl.cleanUrl() ?: DEFAULT_API_BASE_URL,
                roomSlug = rawRoom.cleanValue() ?: DEFAULT_ROOM_SLUG,
                mediaUrl = rawMediaUrl.cleanUrl(),
                deviceId = rawDeviceId.cleanValue(),
                deviceName = rawDeviceName.cleanValue() ?: DEFAULT_DEVICE_NAME,
            )
        }

        private fun String?.cleanValue(): String? {
            val value = this?.trim()
            return value?.takeIf { it.isNotEmpty() }
        }

        private fun String?.cleanUrl(): String? {
            return cleanValue()?.trimEnd('/')
        }
    }
}
