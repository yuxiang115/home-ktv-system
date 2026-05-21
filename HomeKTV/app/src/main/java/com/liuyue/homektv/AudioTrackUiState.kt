package com.liuyue.homektv

data class AudioTrackOption(
    val id: Int,
    val name: String?,
)

fun selectableAudioTracks(rawTracks: List<AudioTrackOption>?): List<AudioTrackOption> {
    return rawTracks.orEmpty().filter { it.id >= 0 }
}

fun describeAudioTrackState(rawTracks: List<AudioTrackOption>?, currentTrackId: Int): String {
    val tracks = selectableAudioTracks(rawTracks)
    if (tracks.isEmpty()) {
        return "音轨未加载"
    }

    val currentIndex = tracks.indexOfFirst { it.id == currentTrackId }
    val current = tracks.getOrNull(currentIndex.coerceAtLeast(0))
    return if (current != null) {
        "音轨 ${currentIndex + 1}/${tracks.size} · ${current.displayName(currentIndex)}"
    } else {
        "音轨 ${tracks.size} 条"
    }
}

fun AudioTrackOption.displayName(index: Int): String {
    val cleanName = name?.trim()?.takeIf { it.isNotEmpty() && it != "Track ${index + 1}" }
    return cleanName ?: "音轨 ${index + 1}"
}
