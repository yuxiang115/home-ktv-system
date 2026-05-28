package com.liuyue.homektv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PlayerApiPayloadsTest {
    @Test
    fun buildsBootstrapPayloadForAndroidLibVlcRuntime() {
        val json = PlayerApiPayloads.bootstrap(
            roomSlug = "living-room",
            deviceId = "android-tv-1",
            deviceName = "客厅 Android TV",
        )

        assertEquals("living-room", json.getString("roomSlug"))
        assertEquals("android-tv-1", json.getString("deviceId"))
        assertEquals("客厅 Android TV", json.getString("deviceName"))
        assertEquals("android-libvlc-tv", json.getJSONObject("capabilities").getString("runtime"))
        assertEquals(true, json.getJSONObject("capabilities").getBoolean("audioTrackSwitching"))
    }

    @Test
    fun buildsHeartbeatPayloadWithNullCurrentQueueEntry() {
        val json = PlayerApiPayloads.heartbeat(
            roomSlug = "living-room",
            deviceId = "android-tv-1",
            currentQueueEntryId = null,
            playbackPositionMs = 0L,
            health = "ok",
        )

        assertEquals("living-room", json.getString("roomSlug"))
        assertEquals("android-tv-1", json.getString("deviceId"))
        assertNull(json.opt("currentQueueEntryId"))
        assertEquals(0L, json.getLong("playbackPositionMs"))
        assertEquals("ok", json.getString("health"))
    }

    @Test
    fun buildsSwitchCommittedTelemetryPayload() {
        val json = PlayerApiPayloads.telemetry(
            roomSlug = "living-room",
            deviceId = "android-tv-1",
            eventType = "playing",
            sessionVersion = 7,
            queueEntryId = "queue-1",
            sourceType = "nas",
            assetId = "asset-1",
            playbackPositionMs = 12345L,
            vocalMode = "original",
            switchFamily = "real-mv-audio-track",
            rollbackAssetId = "asset-1",
            stage = "switch_committed",
            message = null,
            errorCode = null,
        )

        assertEquals("playing", json.getString("eventType"))
        assertEquals(7, json.getInt("sessionVersion"))
        assertEquals("queue-1", json.getString("queueEntryId"))
        assertEquals("nas", json.getString("sourceType"))
        assertEquals("asset-1", json.getString("assetId"))
        assertEquals(12345L, json.getLong("playbackPositionMs"))
        assertEquals("original", json.getString("vocalMode"))
        assertEquals("real-mv-audio-track", json.getString("switchFamily"))
        assertEquals("asset-1", json.getString("rollbackAssetId"))
        assertEquals("switch_committed", json.getString("stage"))
    }
}
