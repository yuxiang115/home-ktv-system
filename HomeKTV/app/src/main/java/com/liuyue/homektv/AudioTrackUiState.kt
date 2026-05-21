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

fun chooseAudioTrackForRef(tracks: List<AudioTrackOption>, trackRef: TrackRef): AudioTrackOption? {
    val selectable = selectableAudioTracks(tracks)
    if (selectable.isEmpty()) {
        return null
    }

    val numericId = trackRef.id.toIntFromTrackId()
    if (numericId != null) {
        selectable.firstOrNull { it.id == numericId }?.let { return it }
    }

    if (trackRef.index > 0) {
        selectable.getOrNull(trackRef.index - 1)?.let { return it }
    }

    selectable.getOrNull(trackRef.index)?.let { return it }

    val label = trackRef.label.trim()
    return if (label.isNotEmpty()) {
        selectable.firstOrNull { it.name?.contains(label, ignoreCase = true) == true }
    } else {
        null
    }
}

fun AudioTrackOption.displayName(index: Int): String {
    val cleanName = name?.trim()?.takeIf { it.isNotEmpty() && it != "Track ${index + 1}" }
    return cleanName ?: "音轨 ${index + 1}"
}

private fun String.toIntFromTrackId(): Int? {
    val value = trim()
    if (value.isEmpty()) {
        return null
    }
    return if (value.startsWith("0x", ignoreCase = true)) {
        value.drop(2).toIntOrNull(16)
    } else {
        value.toIntOrNull()
    }
}
