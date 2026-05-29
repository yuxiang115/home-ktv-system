package com.liuyue.homektv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TvStatusNoticeTest {
    @Test
    fun hidesSteadyPlaybackStatesFromTransientBanner() {
        assertNull(tvStatusNoticeFor("正在播放 · 原唱"))
        assertNull(tvStatusNoticeFor("电视在线，等待点歌"))
    }

    @Test
    fun mapsSwitchFailureToShortDangerNotice() {
        val notice = tvStatusNoticeFor("原唱/伴唱切换失败，已保持当前播放")

        assertEquals("已回退", notice?.label)
        assertEquals("原唱/伴唱切换失败，已保持当前播放", notice?.message)
        assertEquals(TvStatusTone.DANGER, notice?.tone)
        assertEquals(5_000L, notice?.durationMs)
    }

    @Test
    fun mapsSwitchSuccessToReadyNotice() {
        val notice = tvStatusNoticeFor("已切换为 伴唱")

        assertEquals("已切换", notice?.label)
        assertEquals(TvStatusTone.READY, notice?.tone)
        assertEquals(3_200L, notice?.durationMs)
    }

    @Test
    fun mapsLoadingActionToWarningNotice() {
        val notice = tvStatusNoticeFor("正在切换原唱/伴唱")

        assertEquals("准备中", notice?.label)
        assertEquals(TvStatusTone.WARNING, notice?.tone)
        assertEquals(4_500L, notice?.durationMs)
    }

    @Test
    fun mapsIdleStatusCopyForConnectionPill() {
        assertEquals("电视已连接", idleStatusLabelFor("电视在线，等待点歌"))
        assertEquals("电视连接冲突", idleStatusLabelFor("电视连接冲突"))
        assertEquals("正在注册电视", idleStatusLabelFor("正在注册电视"))
    }
}
