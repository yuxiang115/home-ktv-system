package com.liuyue.homektv

data class DemoMediaSample(
    val indexedAssetId: String,
    val title: String,
    val artist: String,
    val extension: String,
    val videoCodec: String,
    val audioCodecs: String,
    val audioTrackCount: Int,
    val resolution: String,
    val durationSec: Int,
    val sizeMb: Int,
) {
    fun rawUrl(apiBaseUrl: String): String {
        return "${apiBaseUrl.trim().trimEnd('/')}/media/ktv-index/$indexedAssetId/raw"
    }

    fun displayTitle(index: Int, total: Int): String {
        return "${index + 1}/$total · $title · $artist"
    }

    fun technicalSummary(): String {
        val minutes = durationSec / 60
        val seconds = durationSec % 60
        return "$extension · $videoCodec · $audioCodecs · ${audioTrackCount}轨 · $resolution · %02d:%02d · ${sizeMb}MB".format(
            minutes,
            seconds,
        )
    }
}

object DemoSamplePlaylist {
    val samples: List<DemoMediaSample> = listOf(
        DemoMediaSample("3312b7a4-bd65-4b9e-b1e6-d991826bf1b2", "忘情歌", "伍佰 CHINA BLUE", ".mpg", "mpeg2video", "mp2+mp2", 2, "720x480", 305, 93),
        DemoMediaSample("56e4df93-19e7-42fd-a6fe-20b216d3a0b9", "路", "伍佰", ".mpg", "mpeg2video", "mp2+mp2", 2, "720x480", 349, 105),
        DemoMediaSample("69db8b0a-4688-47b0-8380-4dad8690dfc2", "自君别后", "陈思思", ".mpg", "mpeg2video", "mp2", 1, "720x480", 226, 62),
        DemoMediaSample("13a52180-9be3-4ed0-8533-9e2be73bd848", "爱没有失败", "游鸿明", ".mpg", "mpeg2video", "mp2+mp2", 2, "720x480", 272, 83),
        DemoMediaSample("11d11a3b-6b38-4cc7-b949-7373eede5408", "故乡", "腾格尔", ".mpg", "mpeg2video", "mp2+mp2", 2, "720x480", 300, 91),
        DemoMediaSample("a4086091-c045-4873-b297-676f89923067", "莎郎嘿SA LANG HAE", "迪克牛仔", ".mpg", "mpeg2video", "mp2", 1, "720x480", 231, 63),
        DemoMediaSample("d45ee9d6-cd79-45d9-a87e-3f25d62b0217", "恶之必要", "蔡依林", ".mpg", "mpeg2video", "mp2+mp2", 2, "720x480", 229, 70),
        DemoMediaSample("18497cb5-ac3a-4126-8ccb-9feddb9b9a91", "城市情人梦", "黄品源", ".mpg", "mpeg2video", "mp2+mp2", 2, "720x480", 268, 137),
        DemoMediaSample("220f566a-199a-4c9c-9814-3ac828448151", "一剪梅", "卓依婷", ".mpg", "mpeg2video", "mp2+mp2", 2, "720x480", 232, 69),
        DemoMediaSample("417dd5e6-930a-4635-b753-f2a3cbff960e", "那个人就是我", "李茂山", ".mpg", "mpeg2video", "mp2+mp2", 2, "720x480", 213, 67),
        DemoMediaSample("2b726b17-69a4-46c6-8605-97f7e23860e6", "爱在路上", "科尔沁", ".mkv", "h264", "mp2+mp2", 2, "720x480", 353, 86),
        DemoMediaSample("71647e4e-ae4c-4cee-b740-739525a22a80", "释放", "圈圈", ".mkv", "h264", "mp2+mp2", 2, "854x480", 219, 47),
        DemoMediaSample("32a8c3ed-832f-4f05-909c-13e74b43ab36", "爱上一个不回家的人", "林忆莲", ".mkv", "rv40", "aac+aac", 2, "704x480", 304, 45),
        DemoMediaSample("227af871-8752-4311-9bb3-05d274e498d8", "路人", "彭佳慧", ".mkv", "rv40", "aac+aac", 2, "480x480", 227, 30),
        DemoMediaSample("32ffaa85-00e3-4a68-9409-27f4949fa4f3", "不敢爱", "邓灵", ".mkv", "rv40", "aac+aac", 2, "720x576", 230, 29),
        DemoMediaSample("8d4cc15b-9143-4bb1-950d-1a98e0477de8", "傻傻的爱你", "陈星安", ".mkv", "rv40", "aac+aac", 2, "720x576", 243, 38),
        DemoMediaSample("e62897a8-a0d4-4842-92bb-ca5ffad1ce1f", "兄弟干杯", "庞龙", ".mkv", "rv40", "aac+aac", 2, "720x576", 256, 42),
        DemoMediaSample("35db4daa-7961-4998-a226-ceffdaa417cb", "霓裳", "刘子菲", ".mkv", "rv40", "aac+aac", 2, "720x576", 266, 35),
        DemoMediaSample("e8754c1b-ff6c-465e-92df-eaf81f96d785", "爱是一颗幸福的子弹", "张丹丹", ".mkv", "rv40", "aac+aac", 2, "720x576", 198, 33),
        DemoMediaSample("0e5e3395-2271-46eb-8b48-a1e4527ab7d2", "小哨所", "初瑞", ".mkv", "rv40", "aac+aac", 2, "720x576", 240, 32),
        DemoMediaSample("e057606d-05cd-4706-ac78-c24f41bc1cc3", "真爱", "刘牧", ".mkv", "rv40", "aac+aac", 2, "720x480", 252, 37),
        DemoMediaSample("b94803d9-9d3d-4fec-96a1-185b05dc7279", "大女孩", "小峰峰", ".mkv", "rv40", "aac+aac", 2, "720x480", 255, 39),
        DemoMediaSample("29a53ab9-6962-4e85-bf8f-5affc6b4b5ae", "晒掉回忆", "王尧", ".mkv", "rv40", "aac+aac", 2, "720x480", 227, 30),
        DemoMediaSample("e29c4578-9155-48c6-81d7-6160db8cd8ad", "新年快乐", "J STAR", ".mkv", "rv40", "aac+aac", 2, "704x480", 257, 60),
        DemoMediaSample("85292bd8-3232-4f63-ba9b-451984147b27", "千千阙歌依然为你唱", "金梅", ".mkv", "rv40", "aac+aac", 2, "720x480", 239, 35),
        DemoMediaSample("c8cb88d9-8581-4040-b285-615af6019b15", "让我默默地爱你", "曾辉彬", ".mkv", "rv40", "aac+aac", 2, "720x576", 255, 35),
        DemoMediaSample("324f5fa8-5e16-4d9a-81b4-76311a619a41", "毛主席和鄂伦春人心连心", "大家唱合唱团", ".mkv", "rv40", "aac", 1, "720x480", 110, 27),
        DemoMediaSample("33c43244-b88e-4b29-972f-fe0648c31e28", "你好不好", "虎二", ".mkv", "h264", "aac+aac", 2, "720x480", 211, 36),
        DemoMediaSample("ac486c97-0c6a-4407-90a0-9ea4eb26865c", "想往侗乡", "魏洪", ".mkv", "rv40", "aac", 1, "720x480", 255, 36),
        DemoMediaSample("237a7a2c-ff59-4518-bca9-aea7ee8f4e64", "我们的大地", "景岗山", ".mkv", "rv40", "aac+aac", 2, "240x480", 294, 38),
    )

    fun nextIndex(currentIndex: Int): Int {
        return Math.floorMod(currentIndex + 1, samples.size)
    }
}
