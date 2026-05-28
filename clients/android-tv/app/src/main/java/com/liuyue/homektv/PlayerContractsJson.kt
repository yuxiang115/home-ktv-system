package com.liuyue.homektv

import org.json.JSONArray
import org.json.JSONObject

object PlayerContractsJson {
    fun bootstrapFromJson(json: JSONObject): BootstrapResult {
        return BootstrapResult(
            status = json.optString("status", "error"),
            snapshot = json.optJSONObject("snapshot")?.let(::roomSnapshotFromJson),
        )
    }

    fun roomSnapshotFromJson(json: JSONObject): RoomSnapshot {
        return RoomSnapshot(
            roomSlug = json.optString("roomSlug", ""),
            sessionVersion = json.optInt("sessionVersion", 0),
            state = json.optString("state", "idle"),
            volumePercent = json.optInt("volumePercent", DEFAULT_ROOM_VOLUME_PERCENT).coerceIn(0, 100),
            pairing = json.optJSONObject("pairing")?.let(::pairingInfoFromJson),
            currentTarget = json.optJSONObject("currentTarget")?.let(::playbackTargetFromJson),
            switchTarget = json.optJSONObject("switchTarget")?.let(::switchTargetFromJson),
            targetVocalMode = json.optNullableString("targetVocalMode"),
            conflict = !json.isNull("conflict"),
            noticeMessage = json.optJSONObject("notice")?.optNullableString("message"),
            generatedAt = json.optNullableString("generatedAt"),
        )
    }

    fun roomSnapshotFromRealtimeMessage(message: String): RoomSnapshot? {
        val envelope = runCatching { JSONObject(message) }.getOrNull() ?: return null
        if (envelope.optString("type") != "room.control.snapshot.updated") {
            return null
        }
        val payload = envelope.optJSONObject("payload") ?: return null
        return roomSnapshotFromJson(payload)
    }

    fun roomInteractionFromRealtimeMessage(message: String): RoomInteractionEvent? {
        val envelope = runCatching { JSONObject(message) }.getOrNull() ?: return null
        if (envelope.optString("type") != "room.interaction.created") {
            return null
        }
        val payload = envelope.optJSONObject("payload") ?: return null
        return roomInteractionFromJson(payload)
    }

    fun switchTransitionFromJson(json: JSONObject): SwitchTransitionResult {
        return SwitchTransitionResult(
            status = json.optString("status", "unavailable"),
            switchTarget = json.optJSONObject("switchTarget")?.let(::switchTargetFromJson),
            reason = json.optNullableString("reason"),
        )
    }

    fun reconnectRecoveryFromJson(json: JSONObject): ReconnectRecoveryResult {
        return ReconnectRecoveryResult(
            status = json.optString("status", "idle"),
            target = json.optJSONObject("target")?.let(::playbackTargetFromJson),
            noticeMessage = json.optJSONObject("notice")?.optNullableString("message"),
        )
    }

    fun playbackTargetFromJson(json: JSONObject): PlaybackTarget {
        return PlaybackTarget(
            roomId = json.optString("roomId", ""),
            sessionVersion = json.optInt("sessionVersion", 0),
            queueEntryId = json.optString("queueEntryId", ""),
            sourceType = json.optString("sourceType", "nas").ifBlank { "nas" },
            songId = json.optString("songId", ""),
            assetId = json.optString("assetId", ""),
            currentQueueEntryPreview = queueEntryPreviewFromJson(
                json.optJSONObject("currentQueueEntryPreview"),
                fallbackQueueEntryId = json.optString("queueEntryId", ""),
            ),
            playbackUrl = json.optString("playbackUrl", ""),
            resumePositionMs = json.optLong("resumePositionMs", 0L),
            vocalMode = json.optString("vocalMode", "unknown"),
            switchFamily = json.optNullableString("switchFamily"),
            playbackProfile = json.optJSONObject("playbackProfile")?.let(::playbackProfileFromJson),
            selectedTrackRef = json.optJSONObject("selectedTrackRef")?.let(::trackRefFromJson),
            nextQueueEntryPreview = json.optJSONObject("nextQueueEntryPreview")?.let {
                queueEntryPreviewFromJson(it, fallbackQueueEntryId = "")
            },
        )
    }

    fun switchTargetFromJson(json: JSONObject): SwitchTarget {
        return SwitchTarget(
            roomId = json.optString("roomId", ""),
            sessionVersion = json.optInt("sessionVersion", 0),
            queueEntryId = json.optString("queueEntryId", ""),
            switchKind = json.optString("switchKind", "asset"),
            sourceType = json.optString("sourceType", "nas").ifBlank { "nas" },
            fromAssetId = json.optString("fromAssetId", ""),
            toAssetId = json.optString("toAssetId", ""),
            playbackUrl = json.optString("playbackUrl", ""),
            switchFamily = json.optNullableString("switchFamily"),
            vocalMode = json.optString("vocalMode", "unknown"),
            resumePositionMs = json.optLong("resumePositionMs", 0L),
            rollbackAssetId = json.optNullableString("rollbackAssetId"),
            playbackProfile = json.optJSONObject("playbackProfile")?.let(::playbackProfileFromJson),
            selectedTrackRef = json.optJSONObject("selectedTrackRef")?.let(::trackRefFromJson),
        )
    }

    private fun queueEntryPreviewFromJson(json: JSONObject?, fallbackQueueEntryId: String): QueueEntryPreview {
        return QueueEntryPreview(
            queueEntryId = json?.optString("queueEntryId", fallbackQueueEntryId) ?: fallbackQueueEntryId,
            songTitle = json?.optString("songTitle", "当前歌曲") ?: "当前歌曲",
            artistName = json?.optString("artistName", "") ?: "",
        )
    }

    private fun pairingInfoFromJson(json: JSONObject): PairingInfo {
        return PairingInfo(
            roomSlug = json.optString("roomSlug", ""),
            controllerUrl = json.optString("controllerUrl", ""),
            qrPayload = json.optString("qrPayload", json.optString("controllerUrl", "")),
            token = json.optString("token", ""),
            tokenExpiresAt = json.optString("tokenExpiresAt", ""),
        )
    }

    private fun trackRefFromJson(json: JSONObject): TrackRef {
        return TrackRef(
            index = json.optInt("index", 0),
            id = json.optString("id", ""),
            label = json.optString("label", ""),
        )
    }

    private fun playbackProfileFromJson(json: JSONObject): PlaybackProfile {
        return PlaybackProfile(
            kind = json.optString("kind", "separate_asset_pair"),
            container = json.optNullableString("container"),
            videoCodec = json.optNullableString("videoCodec"),
            audioCodecs = json.optJSONArray("audioCodecs").toStringList(),
            requiresAudioTrackSelection = json.optBoolean("requiresAudioTrackSelection", false),
        )
    }

    private fun roomInteractionFromJson(json: JSONObject): RoomInteractionEvent? {
        val kind = json.optString("kind", "")
        if (kind != "emoji" && kind != "bullet" && kind != "blessing") {
            return null
        }
        val id = json.optString("id", "")
        val message = json.optString("message", "")
        if (id.isBlank() || message.isBlank()) {
            return null
        }
        return RoomInteractionEvent(
            id = id,
            roomId = json.optString("roomId", ""),
            roomSlug = json.optString("roomSlug", ""),
            kind = kind,
            message = message,
            senderDeviceId = json.optString("senderDeviceId", ""),
            senderName = json.optString("senderName", ""),
            createdAt = json.optString("createdAt", ""),
            expiresAt = json.optString("expiresAt", ""),
        )
    }

    private fun JSONArray?.toStringList(): List<String> {
        if (this == null) return emptyList()
        val values = mutableListOf<String>()
        for (index in 0 until length()) {
            val value = optString(index)
            if (value.isNotBlank()) {
                values.add(value)
            }
        }
        return values
    }

    private fun JSONObject.optNullableString(name: String): String? {
        if (isNull(name)) return null
        return optString(name).takeIf { it.isNotBlank() }
    }
}
