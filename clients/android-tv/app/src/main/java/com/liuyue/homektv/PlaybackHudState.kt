package com.liuyue.homektv

fun playbackStateLabelForStatus(value: String, roomModeActive: Boolean, currentLabel: String? = null): String? {
    return when {
        value.startsWith("正在播放") -> "播放中"
        value == "已暂停" -> "已暂停"
        value == "已停止" || value == "播放结束" -> if (roomModeActive) "待点歌" else "待播放"
        value.contains("播放失败") -> "异常"
        value.contains("缓冲") && currentLabel == "播放中" -> "播放中"
        value.contains("正在打开") || value.contains("缓冲") || value.contains("正在切换") -> "准备中"
        else -> null
    }
}

fun playbackStateLabelForRefresh(
    currentLabel: String,
    roomModeActive: Boolean,
    hasActiveTarget: Boolean,
    hasCurrentMedia: Boolean,
    isPlayerPlaying: Boolean,
): String {
    if (currentLabel == "播放中") {
        return currentLabel
    }

    return playbackStateLabelForMedia(
        roomModeActive = roomModeActive,
        hasActiveTarget = hasActiveTarget,
        hasCurrentMedia = hasCurrentMedia,
        isPlayerPlaying = isPlayerPlaying,
    )
}

fun playbackStateLabelForMedia(
    roomModeActive: Boolean,
    hasActiveTarget: Boolean,
    hasCurrentMedia: Boolean,
    isPlayerPlaying: Boolean,
): String {
    return when {
        !hasActiveTarget && roomModeActive -> "待点歌"
        isPlayerPlaying -> "播放中"
        hasCurrentMedia -> "准备中"
        else -> "待播放"
    }
}
