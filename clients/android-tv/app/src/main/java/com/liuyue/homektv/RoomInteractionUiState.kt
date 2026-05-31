package com.liuyue.homektv

import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import kotlin.math.cos
import kotlin.math.sin

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

data class BulletAccentColor(
    val hex: String,
    val red: Int,
    val green: Int,
    val blue: Int,
) {
    fun rgb(): Int = argb(255)

    fun argb(alpha: Int): Int {
        return ((alpha.coerceIn(0, 255) and 0xFF) shl 24) or
            ((red and 0xFF) shl 16) or
            ((green and 0xFF) shl 8) or
            (blue and 0xFF)
    }
}

private val bulletAccentPalette = listOf(
    BulletAccentColor("#22D3EE", 34, 211, 238),
    BulletAccentColor("#34D399", 52, 211, 153),
    BulletAccentColor("#FACC15", 250, 204, 21),
    BulletAccentColor("#F472B6", 244, 114, 182),
    BulletAccentColor("#A78BFA", 167, 139, 250),
    BulletAccentColor("#FB923C", 251, 146, 60),
    BulletAccentColor("#60A5FA", 96, 165, 250),
    BulletAccentColor("#F8FAFC", 248, 250, 252),
)

fun bulletAccentColor(id: String): BulletAccentColor {
    return bulletAccentPalette[stableHash(id) % bulletAccentPalette.size]
}

data class BulletMarqueePlan(
    val top: Int,
    val startTranslationX: Float,
    val endTranslationX: Float,
)

fun bulletMarqueePlan(
    id: String,
    layerWidth: Int,
    layerHeight: Int,
    bannerWidth: Int,
    bannerHeight: Int,
    horizontalGutter: Int,
    minTop: Int,
    bottomReserved: Int,
): BulletMarqueePlan {
    val safeLayerWidth = layerWidth.coerceAtLeast(1)
    val safeLayerHeight = layerHeight.coerceAtLeast(1)
    val safeBannerWidth = bannerWidth.coerceAtLeast(1)
    val safeBannerHeight = bannerHeight.coerceAtLeast(1)
    val maxTop = (safeLayerHeight - bottomReserved - safeBannerHeight).coerceAtLeast(minTop)
    val rawTop = ((bulletLaneTopPercent(id) / 100f) * safeLayerHeight).toInt()
    return BulletMarqueePlan(
        top = rawTop.coerceIn(minTop, maxTop),
        startTranslationX = (safeLayerWidth + horizontalGutter).toFloat(),
        endTranslationX = -(safeBannerWidth + horizontalGutter).toFloat(),
    )
}

fun blessingStackTopMargins(
    cardHeights: List<Int>,
    firstTop: Int,
    gap: Int,
    minCardHeight: Int,
): List<Int> {
    val margins = mutableListOf<Int>()
    var nextTop = firstTop
    for (height in cardHeights) {
        margins.add(nextTop)
        nextTop += height.coerceAtLeast(minCardHeight) + gap
    }
    return margins
}

data class EmojiPhysicsLaunchPlan(
    val left: Int,
    val top: Int,
    val initialVelocityX: Float,
    val initialVelocityY: Float,
    val initialRotation: Float,
    val angularVelocity: Float,
    val launchAngleDegrees: Float,
    val launchSpeed: Float,
)

data class EmojiPhysicsTuning(
    val gravityY: Float = 16.5f,
    val pixelsPerMeter: Float = 34f,
    val density: Float = 0.0013f,
    val friction: Float = 0.035f,
    val restitution: Float = 0.47f,
    val linearDamping: Float = 0.08f,
    val angularDamping: Float = 0.04f,
)

fun emojiPhysicsTuning(): EmojiPhysicsTuning = EmojiPhysicsTuning()

fun emojiPhysicsLaunchPlan(
    id: String,
    layerWidth: Int,
    layerHeight: Int,
    size: Int,
    margin: Int,
): EmojiPhysicsLaunchPlan {
    val safeLayerWidth = layerWidth.coerceAtLeast(size + 1)
    val safeLayerHeight = layerHeight.coerceAtLeast(size + 1)
    val safeSize = size.coerceAtLeast(1)
    val hash = stableHash(id)
    val startCenter = horizontalPositionFromHash(hash, safeLayerWidth, margin)
    val left = (startCenter - safeSize / 2).coerceIn(0, (safeLayerWidth - safeSize).coerceAtLeast(0))
    val top = (safeLayerHeight - safeSize - (safeLayerHeight * 0.03f).toInt()).coerceIn(
        0,
        (safeLayerHeight - safeSize).coerceAtLeast(0),
    )
    val rightLaunch = hash % 2 == 0
    val angleOffset = ((hash / 7) % 27).toFloat()
    val launchAngleDegrees = if (rightLaunch) 48f + angleOffset else 116f + angleOffset
    val launchRadians = Math.toRadians(launchAngleDegrees.toDouble())
    val launchSpeed = 2_400f + ((hash / 19) % 1_300)
    val angularDirection = if (rightLaunch) 1f else -1f
    return EmojiPhysicsLaunchPlan(
        left = left,
        top = top,
        initialVelocityX = (cos(launchRadians) * launchSpeed).toFloat(),
        initialVelocityY = -(sin(launchRadians) * launchSpeed).toFloat(),
        initialRotation = ((hash % 42) - 21).toFloat(),
        angularVelocity = angularDirection * (8.5f + (hash % 70) / 10f),
        launchAngleDegrees = launchAngleDegrees,
        launchSpeed = launchSpeed,
    )
}

fun stableHash(value: String): Int {
    var hash = -2128831035
    for (character in value) {
        hash = hash xor character.code
        hash *= 16777619
    }
    return hash and Int.MAX_VALUE
}

private fun horizontalPositionFromHash(hash: Int, width: Int, margin: Int): Int {
    val available = (width - margin * 2).coerceAtLeast(1)
    return margin + hash % available
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
