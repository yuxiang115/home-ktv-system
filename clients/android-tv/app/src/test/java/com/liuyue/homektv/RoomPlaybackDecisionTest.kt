package com.liuyue.homektv

import org.junit.Assert.assertEquals
import org.junit.Test

class RoomPlaybackDecisionTest {
    @Test
    fun stopsWhenSnapshotHasNoCurrentTarget() {
        val decision = RoomPlaybackDecision.decide(
            snapshot = snapshot(currentTarget = null),
            activeTarget = target(assetId = "asset-1"),
            switchInFlight = false,
        )

        assertEquals(PlaybackAction.StopPlayback, decision)
    }

    @Test
    fun playsNewTargetWhenAssetOrQueueEntryChanges() {
        val nextTarget = target(assetId = "asset-2", queueEntryId = "queue-2")

        val decision = RoomPlaybackDecision.decide(
            snapshot = snapshot(currentTarget = nextTarget),
            activeTarget = target(assetId = "asset-1", queueEntryId = "queue-1"),
            switchInFlight = false,
        )

        assertEquals(PlaybackAction.PlayNewTarget(nextTarget), decision)
    }

    @Test
    fun playsNewTargetWhenSourceTypeChangesForSameQueueAndAsset() {
        val nextTarget = target(sourceType = "online", assetId = "asset-1", queueEntryId = "queue-1")

        val decision = RoomPlaybackDecision.decide(
            snapshot = snapshot(currentTarget = nextTarget),
            activeTarget = target(sourceType = "nas", assetId = "asset-1", queueEntryId = "queue-1"),
            switchInFlight = false,
        )

        assertEquals(PlaybackAction.PlayNewTarget(nextTarget), decision)
    }

    @Test
    fun switchesVocalModeWhenServerHasPendingModeChange() {
        val current = target(vocalMode = "instrumental")

        val decision = RoomPlaybackDecision.decide(
            snapshot = snapshot(currentTarget = current, targetVocalMode = "original"),
            activeTarget = current,
            switchInFlight = false,
        )

        assertEquals(PlaybackAction.SwitchVocalMode, decision)
    }

    @Test
    fun keepsPlayingWhenTargetIsAlreadyCurrent() {
        val current = target(assetId = "asset-1", queueEntryId = "queue-1", vocalMode = "instrumental")

        val decision = RoomPlaybackDecision.decide(
            snapshot = snapshot(currentTarget = current, targetVocalMode = "instrumental"),
            activeTarget = current,
            switchInFlight = false,
        )

        assertEquals(PlaybackAction.KeepPlaying, decision)
    }

    @Test
    fun keepsPlayingWhenLocalSwitchAlreadyReachedPendingServerMode() {
        val serverTarget = target(assetId = "asset-1", queueEntryId = "queue-1", vocalMode = "instrumental")
        val locallySwitchedTarget = target(assetId = "asset-1", queueEntryId = "queue-1", vocalMode = "original")

        val decision = RoomPlaybackDecision.decide(
            snapshot = snapshot(currentTarget = serverTarget, targetVocalMode = "original"),
            activeTarget = locallySwitchedTarget,
            switchInFlight = false,
        )

        assertEquals(PlaybackAction.KeepPlaying, decision)
    }

    private fun snapshot(
        currentTarget: PlaybackTarget?,
        targetVocalMode: String? = currentTarget?.vocalMode,
    ): RoomSnapshot {
        return RoomSnapshot(
            roomSlug = "living-room",
            sessionVersion = 1,
            state = "playing",
            currentTarget = currentTarget,
            switchTarget = null,
            targetVocalMode = targetVocalMode,
            conflict = false,
            noticeMessage = null,
            generatedAt = "2026-05-21T00:00:00.000Z",
        )
    }

    private fun target(
        assetId: String = "asset-1",
        queueEntryId: String = "queue-1",
        sourceType: String = "nas",
        vocalMode: String = "instrumental",
    ): PlaybackTarget {
        return PlaybackTarget(
            roomId = "room-1",
            sessionVersion = 1,
            queueEntryId = queueEntryId,
            sourceType = sourceType,
            songId = "song-1",
            assetId = assetId,
            currentQueueEntryPreview = QueueEntryPreview(
                queueEntryId = queueEntryId,
                songTitle = "稻香",
                artistName = "周杰伦",
            ),
            playbackUrl = "http://192.168.5.64:4000/media/$sourceType/$assetId",
            resumePositionMs = 0L,
            vocalMode = vocalMode,
            switchFamily = "real-mv-audio-track",
            playbackProfile = null,
            selectedTrackRef = null,
            nextQueueEntryPreview = null,
        )
    }
}
