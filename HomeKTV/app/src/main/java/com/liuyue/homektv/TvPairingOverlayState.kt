package com.liuyue.homektv

data class TvPairingOverlayState(
    val showIdlePairing: Boolean,
    val showPlayingQr: Boolean,
    val showPlaybackHud: Boolean,
    val qrPayload: String?,
) {
    companion object {
        fun from(roomModeActive: Boolean, snapshot: RoomSnapshot?): TvPairingOverlayState {
            if (!roomModeActive) {
                return TvPairingOverlayState(
                    showIdlePairing = false,
                    showPlayingQr = false,
                    showPlaybackHud = true,
                    qrPayload = null,
                )
            }

            val qrPayload = snapshot?.pairing?.qrPayload?.takeIf { it.isNotBlank() }
            val isPlaying = snapshot?.currentTarget != null
            return TvPairingOverlayState(
                showIdlePairing = !isPlaying,
                showPlayingQr = isPlaying && qrPayload != null,
                showPlaybackHud = isPlaying,
                qrPayload = qrPayload,
            )
        }
    }
}
