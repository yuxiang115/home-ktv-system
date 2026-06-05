package com.liuyue.homektv

sealed class PlaybackAction {
    data object StopPlayback : PlaybackAction()
    data class PlayNewTarget(val target: PlaybackTarget) : PlaybackAction()
    data object SwitchVocalMode : PlaybackAction()
    data object KeepPlaying : PlaybackAction()
}

object RoomPlaybackDecision {
    fun decide(
        snapshot: RoomSnapshot,
        activeTarget: PlaybackTarget?,
        switchInFlight: Boolean,
    ): PlaybackAction {
        val currentTarget = snapshot.currentTarget
        if (currentTarget == null) {
            return PlaybackAction.StopPlayback
        }

        if (
            activeTarget == null ||
            activeTarget.queueEntryId != currentTarget.queueEntryId ||
            activeTarget.sourceType != currentTarget.sourceType ||
            activeTarget.assetId != currentTarget.assetId
        ) {
            return PlaybackAction.PlayNewTarget(currentTarget)
        }

        val targetVocalMode = snapshot.targetVocalMode
        if (targetVocalMode != null && activeTarget.vocalMode == targetVocalMode) {
            return PlaybackAction.KeepPlaying
        }

        if (!switchInFlight && targetVocalMode != null && targetVocalMode != currentTarget.vocalMode) {
            return PlaybackAction.SwitchVocalMode
        }

        return PlaybackAction.KeepPlaying
    }
}
