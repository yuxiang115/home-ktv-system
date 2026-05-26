package com.liuyue.homektv

import org.json.JSONObject

object PlayerApiPayloads {
    fun bootstrap(
        roomSlug: String,
        deviceId: String,
        deviceName: String,
    ): JSONObject {
        return JSONObject()
            .put("roomSlug", roomSlug)
            .put("deviceId", deviceId)
            .put("deviceName", deviceName)
            .put(
                "capabilities",
                JSONObject()
                    .put("runtime", "android-libvlc-tv")
                    .put("videoPool", "single-libvlc")
                    .put("audioTrackSwitching", true)
                    .put("decoder", "libvlc"),
            )
    }

    fun heartbeat(
        roomSlug: String,
        deviceId: String,
        currentQueueEntryId: String?,
        playbackPositionMs: Long,
        health: String,
    ): JSONObject {
        return JSONObject()
            .put("roomSlug", roomSlug)
            .put("deviceId", deviceId)
            .put("currentQueueEntryId", currentQueueEntryId)
            .put("playbackPositionMs", playbackPositionMs.coerceAtLeast(0L))
            .put("health", health)
    }

    fun telemetry(
        roomSlug: String,
        deviceId: String,
        eventType: String,
        sessionVersion: Int,
        queueEntryId: String,
        assetId: String,
        playbackPositionMs: Long,
        vocalMode: String,
        switchFamily: String?,
        rollbackAssetId: String?,
        stage: String?,
        message: String?,
        errorCode: String?,
    ): JSONObject {
        return JSONObject()
            .put("roomSlug", roomSlug)
            .put("deviceId", deviceId)
            .put("eventType", eventType)
            .put("sessionVersion", sessionVersion)
            .put("queueEntryId", queueEntryId)
            .put("assetId", assetId)
            .put("playbackPositionMs", playbackPositionMs.coerceAtLeast(0L))
            .put("vocalMode", vocalMode)
            .put("switchFamily", switchFamily)
            .put("rollbackAssetId", rollbackAssetId)
            .put("stage", stage)
            .put("message", message)
            .put("errorCode", errorCode)
    }

    fun switchTransition(
        roomSlug: String,
        playbackPositionMs: Long,
    ): JSONObject {
        return JSONObject()
            .put("roomSlug", roomSlug)
            .put("playbackPositionMs", playbackPositionMs.coerceAtLeast(0L))
    }

    fun reconnectRecovery(
        roomSlug: String,
        deviceId: String,
    ): JSONObject {
        return JSONObject()
            .put("roomSlug", roomSlug)
            .put("deviceId", deviceId)
    }
}
