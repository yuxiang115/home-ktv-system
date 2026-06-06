package com.liuyue.homektv

import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Paths

class PlaybackHudLayoutSourceTest {
    @Test
    fun playbackHudContentRowsUseExplicitWrapContentWidth() {
        val sourcePath = Paths.get("src/main/java/com/liuyue/homektv/MainActivity.kt")
        val source = Files.readString(sourcePath)

        assertTrue(
            "progressText must not rely on LinearLayout.addView(view), whose default width is MATCH_PARENT.",
            hasExplicitWrapContentBottomPanelRow(source, "progressText"),
        )
        assertTrue(
            "metaRow must not rely on LinearLayout.addView(view), whose default width is MATCH_PARENT.",
            hasExplicitWrapContentBottomPanelRow(source, "metaRow"),
        )
    }

    private fun hasExplicitWrapContentBottomPanelRow(source: String, childName: String): Boolean {
        val pattern = Regex(
            """bottomPanel\.addView\(\s*$childName,\s*LinearLayout\.LayoutParams\(LinearLayout\.LayoutParams\.WRAP_CONTENT,\s*LinearLayout\.LayoutParams\.WRAP_CONTENT\),\s*\)""",
            setOf(RegexOption.MULTILINE, RegexOption.DOT_MATCHES_ALL),
        )
        return pattern.containsMatchIn(source)
    }
}
