package com.liuyue.homektv

data class LaunchConfig(
    val apiBaseUrl: String,
    val roomSlug: String,
    val mediaUrl: String?,
) {
    companion object {
        private const val DEFAULT_API_BASE_URL = "http://192.168.5.64:4000"
        private const val DEFAULT_ROOM_SLUG = "living-room"

        fun from(
            rawApiBaseUrl: String?,
            rawRoom: String?,
            rawMediaUrl: String?,
        ): LaunchConfig {
            return LaunchConfig(
                apiBaseUrl = rawApiBaseUrl.cleanUrl() ?: DEFAULT_API_BASE_URL,
                roomSlug = rawRoom.cleanValue() ?: DEFAULT_ROOM_SLUG,
                mediaUrl = rawMediaUrl.cleanUrl(),
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
