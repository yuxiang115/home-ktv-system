package com.liuyue.homektv

data class QueueEntryPreview(
    val queueEntryId: String,
    val songTitle: String,
    val artistName: String,
)

data class TrackRef(
    val index: Int,
    val id: String,
    val label: String,
)

data class PlaybackProfile(
    val kind: String,
    val container: String?,
    val videoCodec: String?,
    val audioCodecs: List<String>,
    val requiresAudioTrackSelection: Boolean,
)

data class PlaybackTarget(
    val roomId: String,
    val sessionVersion: Int,
    val queueEntryId: String,
    val assetId: String,
    val currentQueueEntryPreview: QueueEntryPreview,
    val playbackUrl: String,
    val resumePositionMs: Long,
    val vocalMode: String,
    val switchFamily: String?,
    val playbackProfile: PlaybackProfile?,
    val selectedTrackRef: TrackRef?,
    val nextQueueEntryPreview: QueueEntryPreview?,
)

data class PairingInfo(
    val roomSlug: String,
    val controllerUrl: String,
    val qrPayload: String,
    val token: String,
    val tokenExpiresAt: String,
)

data class SwitchTarget(
    val roomId: String,
    val sessionVersion: Int,
    val queueEntryId: String,
    val switchKind: String,
    val fromAssetId: String,
    val toAssetId: String,
    val playbackUrl: String,
    val switchFamily: String?,
    val vocalMode: String,
    val resumePositionMs: Long,
    val rollbackAssetId: String?,
    val playbackProfile: PlaybackProfile?,
    val selectedTrackRef: TrackRef?,
)

data class RoomSnapshot(
    val roomSlug: String,
    val sessionVersion: Int,
    val state: String,
    val pairing: PairingInfo? = null,
    val currentTarget: PlaybackTarget?,
    val switchTarget: SwitchTarget?,
    val targetVocalMode: String?,
    val conflict: Boolean,
    val noticeMessage: String?,
    val generatedAt: String?,
)

data class BootstrapResult(
    val status: String,
    val snapshot: RoomSnapshot?,
)

data class SwitchTransitionResult(
    val status: String,
    val switchTarget: SwitchTarget?,
    val reason: String?,
)

data class ReconnectRecoveryResult(
    val status: String,
    val target: PlaybackTarget?,
    val noticeMessage: String?,
)
