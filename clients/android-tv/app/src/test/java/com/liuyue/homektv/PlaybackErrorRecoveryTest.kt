package com.liuyue.homektv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PlaybackErrorRecoveryTest {
    @Test
    fun retriesFirstPlaybackErrorFromSlightlyEarlierPosition() {
        val recovery = PlaybackErrorRecovery(maxRetriesPerQueueEntry = 1, rewindMs = 1_500L)

        val retryPosition = recovery.nextRetryPosition("queue-1", currentPositionMs = 21_000L)

        assertEquals(19_500L, retryPosition)
    }

    @Test
    fun stopsRetryingAfterRetryLimitForSameQueueEntry() {
        val recovery = PlaybackErrorRecovery(maxRetriesPerQueueEntry = 1, rewindMs = 1_500L)

        recovery.nextRetryPosition("queue-1", currentPositionMs = 21_000L)
        val retryPosition = recovery.nextRetryPosition("queue-1", currentPositionMs = 22_000L)

        assertNull(retryPosition)
    }

    @Test
    fun startsFreshForDifferentQueueEntry() {
        val recovery = PlaybackErrorRecovery(maxRetriesPerQueueEntry = 1, rewindMs = 1_500L)

        recovery.nextRetryPosition("queue-1", currentPositionMs = 21_000L)
        val retryPosition = recovery.nextRetryPosition("queue-2", currentPositionMs = 800L)

        assertEquals(0L, retryPosition)
    }
}
