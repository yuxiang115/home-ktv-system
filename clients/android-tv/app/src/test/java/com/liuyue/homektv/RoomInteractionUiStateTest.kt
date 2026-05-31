package com.liuyue.homektv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RoomInteractionUiStateTest {
    @Test
    fun computesInteractionTtlFromIsoTimestamps() {
        val ttl = interactionTtlMs(
            interaction(
                createdAt = "2026-05-21T00:00:00.000Z",
                expiresAt = "2026-05-21T00:00:07.000Z",
            ),
            fallbackMs = 12_000L,
        )

        assertEquals(7_000L, ttl)
    }

    @Test
    fun sortsBlessingsNewestFirst() {
        val old = interaction(id = "old", kind = "blessing", createdAt = "2026-05-21T00:00:00.000Z")
        val newer = interaction(id = "new", kind = "blessing", createdAt = "2026-05-21T00:00:03.000Z")

        val sorted = sortBlessingsNewestFirst(listOf(old, newer))

        assertEquals(listOf("new", "old"), sorted.map { it.id })
    }

    @Test
    fun placesBulletLanesInsideReadableBand() {
        val topPercent = bulletLaneTopPercent("interaction-1")

        assertTrue(topPercent >= 11f)
        assertTrue(topPercent <= 74f)
    }

    @Test
    fun selectsStableVariedBulletAccentColors() {
        val first = bulletAccentColor("interaction-bullet-1")
        val repeated = bulletAccentColor("interaction-bullet-1")
        val accentColors = (1..8).map { index -> bulletAccentColor("interaction-bullet-$index").hex }

        assertEquals(first, repeated)
        assertTrue(accentColors.all { color -> color.matches(Regex("^#[0-9A-F]{6}$")) })
        assertTrue(accentColors.toSet().size > 1)
    }

    @Test
    fun computesBulletMarqueeFromVisibleLayerBounds() {
        val plan = bulletMarqueePlan(
            id = "interaction-1",
            layerWidth = 1920,
            layerHeight = 1080,
            bannerWidth = 480,
            bannerHeight = 72,
            horizontalGutter = 48,
            minTop = 88,
            bottomReserved = 150,
        )

        assertEquals(1968f, plan.startTranslationX)
        assertEquals(-528f, plan.endTranslationX)
        assertTrue(plan.top in 88..858)
    }

    @Test
    fun stacksBlessingsByMeasuredHeightWithoutOverlap() {
        val topMargins = blessingStackTopMargins(
            cardHeights = listOf(112, 96, 132),
            firstTop = 52,
            gap = 14,
            minCardHeight = 84,
        )

        assertEquals(listOf(52, 178, 288), topMargins)
    }

    @Test
    fun createsBouncyEmojiPhysicsLaunchPlan() {
        val plan = emojiPhysicsLaunchPlan(
            id = "interaction-rocket",
            layerWidth = 1920,
            layerHeight = 1080,
            size = 112,
            margin = 120,
        )

        assertTrue(plan.left in 0..1808)
        assertTrue(plan.top in 0..968)
        assertTrue(plan.launchAngleDegrees < 75f || plan.launchAngleDegrees > 115f)
        assertTrue(plan.launchSpeed in 2_400f..3_700f)
        assertTrue(plan.initialVelocityY < 0f)
        assertTrue(kotlin.math.abs(plan.angularVelocity) >= 8f)
        assertTrue(kotlin.math.abs(plan.angularVelocity) <= 16f)
    }

    private fun interaction(
        id: String = "interaction-1",
        kind: String = "bullet",
        createdAt: String = "2026-05-21T00:00:00.000Z",
        expiresAt: String = "2026-05-21T00:00:07.000Z",
    ): RoomInteractionEvent {
        return RoomInteractionEvent(
            id = id,
            roomId = "room-1",
            roomSlug = "living-room",
            kind = kind,
            message = "今晚开心",
            senderDeviceId = "phone-a",
            senderName = "客厅手机",
            createdAt = createdAt,
            expiresAt = expiresAt,
        )
    }
}
