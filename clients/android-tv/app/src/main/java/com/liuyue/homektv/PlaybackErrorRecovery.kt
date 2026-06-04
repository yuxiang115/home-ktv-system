package com.liuyue.homektv

class PlaybackErrorRecovery(
    private val maxRetriesPerQueueEntry: Int,
    private val rewindMs: Long,
) {
    private var currentQueueEntryId: String? = null
    private var attempts = 0

    fun nextRetryPosition(queueEntryId: String, currentPositionMs: Long): Long? {
        if (currentQueueEntryId != queueEntryId) {
            currentQueueEntryId = queueEntryId
            attempts = 0
        }
        if (attempts >= maxRetriesPerQueueEntry) {
            return null
        }

        attempts += 1
        return (currentPositionMs - rewindMs).coerceAtLeast(0L)
    }

    fun clear() {
        currentQueueEntryId = null
        attempts = 0
    }
}
