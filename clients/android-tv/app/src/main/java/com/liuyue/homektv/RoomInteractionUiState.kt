package com.liuyue.homektv

import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

fun interactionTtlMs(interaction: RoomInteractionEvent, fallbackMs: Long): Long {
    val createdAtMs = parseIsoUtcMs(interaction.createdAt)
    val expiresAtMs = parseIsoUtcMs(interaction.expiresAt)
    if (createdAtMs == null || expiresAtMs == null || expiresAtMs <= createdAtMs) {
        return fallbackMs
    }
    return (expiresAtMs - createdAtMs).coerceAtLeast(1_000L)
}

fun sortBlessingsNewestFirst(interactions: List<RoomInteractionEvent>): List<RoomInteractionEvent> {
    return interactions
        .mapIndexed { index, interaction -> index to interaction }
        .sortedWith(compareByDescending<Pair<Int, RoomInteractionEvent>> { parseIsoUtcMs(it.second.createdAt) ?: 0L }
            .thenByDescending { it.first })
        .map { it.second }
}

fun bulletLaneTopPercent(id: String): Float {
    val hash = stableHash(id)
    val lane = hash % 14
    val laneOffset = ((hash / 14) % 4) * 0.8f
    return 11f + lane * 4.6f + laneOffset
}

fun stableHash(value: String): Int {
    var hash = -2128831035
    for (character in value) {
        hash = hash xor character.code
        hash *= 16777619
    }
    return hash and Int.MAX_VALUE
}

private fun parseIsoUtcMs(value: String): Long? {
    if (value.isBlank()) {
        return null
    }
    return runCatching { isoUtcFormat.get()?.parse(value)?.time }.getOrNull()
}

private val isoUtcFormat = object : ThreadLocal<SimpleDateFormat>() {
    override fun initialValue(): SimpleDateFormat {
        return SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }
    }
}
