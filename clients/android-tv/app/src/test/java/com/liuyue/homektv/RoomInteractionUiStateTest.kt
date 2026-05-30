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
    fun createsBoundedBouncyEmojiLaunchPlan() {
        val plan = emojiLaunchPlan(
            id = "interaction-rocket",
            layerWidth = 1920,
            layerHeight = 1080,
            size = 112,
            margin = 120,
        )

        assertTrue(plan.left in 0..1808)
        assertTrue(plan.top in 0..968)
        assertTrue(plan.targetTranslationY < -420f)
        assertTrue(kotlin.math.abs(plan.initialVelocityX) >= 1800f)
        assertTrue(plan.initialVelocityY <= -3600f)
        assertTrue(plan.minTranslationX <= plan.targetTranslationX)
        assertTrue(plan.maxTranslationX >= plan.targetTranslationX)
        assertTrue(plan.minTranslationY <= plan.targetTranslationY)
        assertTrue(plan.maxTranslationY >= 0f)
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
