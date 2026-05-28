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
