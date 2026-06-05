package com.liuyue.homektv

import org.json.JSONObject

object PlayerApiPayloads {
    fun bootstrap(
        deviceId: String,
        deviceName: String,
    ): JSONObject {
        return JSONObject()
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
        deviceId: String,
        currentQueueEntryId: String?,
        playbackPositionMs: Long,
        health: String,
    ): JSONObject {
        return JSONObject()
            .put("deviceId", deviceId)
            .put("currentQueueEntryId", currentQueueEntryId)
            .put("playbackPositionMs", playbackPositionMs.coerceAtLeast(0L))
            .put("health", health)
    }

    fun telemetry(
        deviceId: String,
        eventType: String,
        sessionVersion: Int,
        queueEntryId: String,
        sourceType: String,
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
            .put("deviceId", deviceId)
            .put("eventType", eventType)
            .put("sessionVersion", sessionVersion)
            .put("queueEntryId", queueEntryId)
            .put("sourceType", sourceType)
            .put("assetId", assetId)
            .put("playbackPositionMs", playbackPositionMs.coerceAtLeast(0L))
            .put("vocalMode", vocalMode)
            .put("switchFamily", switchFamily)
            .put("rollbackAssetId", rollbackAssetId)
            .put("stage", stage)
            .put("message", message)
            .put("errorCode", errorCode)
    }

    fun switchTransition(playbackPositionMs: Long): JSONObject {
        return JSONObject()
            .put("playbackPositionMs", playbackPositionMs.coerceAtLeast(0L))
    }

    fun reconnectRecovery(
        deviceId: String,
    ): JSONObject {
        return JSONObject()
            .put("deviceId", deviceId)
    }
}
