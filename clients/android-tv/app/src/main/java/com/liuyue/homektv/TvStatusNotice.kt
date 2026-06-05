package com.liuyue.homektv

enum class TvStatusTone {
    NEUTRAL,
    READY,
    WARNING,
    DANGER,
}

data class TvStatusNotice(
    val label: String,
    val message: String,
    val tone: TvStatusTone,
    val durationMs: Long,
)

fun tvStatusNoticeFor(rawMessage: String): TvStatusNotice? {
    val message = rawMessage.trim()
    if (message.isEmpty() || isSteadyStateMessage(message)) {
        return null
    }

    val tone = statusToneFor(message)
    return TvStatusNotice(
        label = statusLabelFor(message, tone),
        message = message,
        tone = tone,
        durationMs = statusDurationFor(message, tone),
    )
}

fun idleStatusLabelFor(rawMessage: String): String? {
    val message = rawMessage.trim()
    return when {
        message.contains("注册失败") || message.contains("快照失败") -> "连接异常"
        message.contains("正在注册") -> "正在注册电视"
        message.contains("等待点歌") || message.contains("电视在线") -> "电视已连接"
        message.contains("实时连接已断开") || message.contains("实时连接异常") -> "轮询同步中"
        else -> null
    }
}

private fun isSteadyStateMessage(message: String): Boolean {
    return message == "电视在线，等待点歌" ||
        message == "已停止" ||
        message == "已暂停" ||
        message == "正在播放" ||
        message.startsWith("正在播放 ·")
}

private fun statusToneFor(message: String): TvStatusTone {
    return when {
        message.contains("失败") || message.contains("冲突") || message.contains("异常") -> TvStatusTone.DANGER
        message.contains("暂无") || message.contains("未加载") || message.contains("未发现") || message.contains("缓冲") ||
            message.contains("正在") -> TvStatusTone.WARNING
        message.contains("已切换") || message.contains("已恢复") || message.contains("播放结束") -> TvStatusTone.READY
        else -> TvStatusTone.NEUTRAL
    }
}

private fun statusLabelFor(message: String, tone: TvStatusTone): String {
    if (message.contains("切换失败")) {
        return "已回退"
    }
    if (message.contains("已切换")) {
        return "已切换"
    }
    if (message.contains("正在")) {
        return "准备中"
    }
    if (message.contains("恢复")) {
        return "已恢复"
    }
    if (message.contains("失败") || message.contains("异常")) {
        return "提示"
    }
    return when (tone) {
        TvStatusTone.READY -> "完成"
        TvStatusTone.WARNING -> "提示"
        TvStatusTone.DANGER -> "提示"
        TvStatusTone.NEUTRAL -> "提示"
    }
}

private fun statusDurationFor(message: String, tone: TvStatusTone): Long {
    if (message.contains("正在")) {
        return 4_500L
    }
    if (tone == TvStatusTone.READY) {
        return 3_200L
    }
    return 5_000L
}
