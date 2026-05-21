package com.liuyue.homektv

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.KeyEvent
import android.view.SurfaceView
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import org.videolan.libvlc.LibVLC
import org.videolan.libvlc.Media
import org.videolan.libvlc.MediaPlayer

class MainActivity : Activity() {
    private lateinit var surfaceView: SurfaceView
    private lateinit var statusText: TextView
    private lateinit var sourceText: TextView
    private lateinit var sampleText: TextView
    private lateinit var progressText: TextView
    private lateinit var audioTrackText: TextView
    private lateinit var nextSampleButton: Button
    private lateinit var libVlc: LibVLC
    private lateinit var mediaPlayer: MediaPlayer

    private val progressHandler = Handler(Looper.getMainLooper())
    private val progressTicker = object : Runnable {
        override fun run() {
            updateProgress()
            progressHandler.postDelayed(this, 1000)
        }
    }

    private var currentMediaUrl: String? = null
    private var currentApiBaseUrl: String = ""
    private var currentSampleIndex: Int = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        hideSystemUi()

        buildLayout()
        setupPlayer()

        val config = launchConfigFromIntent(intent)
        applyLaunchConfig(config)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        applyLaunchConfig(launchConfigFromIntent(intent))
    }

    override fun onResume() {
        super.onResume()
        hideSystemUi()
        progressHandler.post(progressTicker)
    }

    override fun onPause() {
        super.onPause()
        progressHandler.removeCallbacks(progressTicker)
    }

    override fun onDestroy() {
        progressHandler.removeCallbacks(progressTicker)
        if (::mediaPlayer.isInitialized) {
            mediaPlayer.setEventListener(null)
            mediaPlayer.stop()
            mediaPlayer.vlcVout.detachViews()
            mediaPlayer.release()
        }
        if (::libVlc.isInitialized) {
            libVlc.release()
        }
        super.onDestroy()
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        return when (keyCode) {
            KeyEvent.KEYCODE_DPAD_CENTER,
            KeyEvent.KEYCODE_ENTER -> {
                if (::nextSampleButton.isInitialized && nextSampleButton.isFocused) {
                    playNextDemoSample()
                } else {
                    togglePlayback()
                }
                true
            }

            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
            KeyEvent.KEYCODE_SPACE -> {
                togglePlayback()
                true
            }

            KeyEvent.KEYCODE_MEDIA_NEXT,
            KeyEvent.KEYCODE_BUTTON_R1 -> {
                playNextDemoSample()
                true
            }

            KeyEvent.KEYCODE_DPAD_LEFT,
            KeyEvent.KEYCODE_MEDIA_REWIND -> {
                seekBy(-10_000L)
                true
            }

            KeyEvent.KEYCODE_DPAD_RIGHT,
            KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> {
                seekBy(10_000L)
                true
            }

            KeyEvent.KEYCODE_DPAD_UP -> {
                switchAudioTrack(1)
                true
            }

            KeyEvent.KEYCODE_DPAD_DOWN -> {
                switchAudioTrack(-1)
                true
            }

            else -> super.onKeyDown(keyCode, event)
        }
    }

    private fun buildLayout() {
        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            keepScreenOn = true
        }

        surfaceView = SurfaceView(this).apply {
            keepScreenOn = true
        }
        root.addView(
            surfaceView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )

        val topPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(28), dp(22), dp(28), dp(18))
            setBackgroundColor(Color.argb(170, 0, 0, 0))
        }
        root.addView(
            topPanel,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.TOP,
            ),
        )

        val titleText = TextView(this).apply {
            text = "HomeKTV Android TV"
            textSize = 28f
            setTextColor(Color.WHITE)
            includeFontPadding = false
        }
        topPanel.addView(titleText)

        statusText = TextView(this).apply {
            textSize = 19f
            setTextColor(Color.rgb(51, 209, 122))
            setPadding(0, dp(10), 0, 0)
        }
        topPanel.addView(statusText)

        sourceText = TextView(this).apply {
            textSize = 14f
            setTextColor(Color.rgb(210, 214, 220))
            setPadding(0, dp(8), 0, 0)
            maxLines = 3
        }
        topPanel.addView(sourceText)

        sampleText = TextView(this).apply {
            textSize = 17f
            setTextColor(Color.WHITE)
            setPadding(0, dp(10), 0, 0)
            maxLines = 3
        }
        topPanel.addView(sampleText)

        val bottomPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(28), dp(16), dp(28), dp(18))
            setBackgroundColor(Color.argb(170, 0, 0, 0))
        }
        root.addView(
            bottomPanel,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM,
            ),
        )

        progressText = TextView(this).apply {
            textSize = 26f
            setTextColor(Color.WHITE)
            includeFontPadding = false
        }
        bottomPanel.addView(progressText)

        audioTrackText = TextView(this).apply {
            textSize = 18f
            setTextColor(Color.rgb(210, 214, 220))
            setPadding(0, dp(8), 0, 0)
        }
        bottomPanel.addView(audioTrackText)

        nextSampleButton = Button(this).apply {
            text = "下一首样本"
            textSize = 18f
            isAllCaps = false
            setPadding(dp(22), dp(8), dp(22), dp(8))
            setOnClickListener { playNextDemoSample() }
        }
        bottomPanel.addView(
            nextSampleButton,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply {
                topMargin = dp(12)
            },
        )

        setContentView(root)
        nextSampleButton.requestFocus()
    }

    private fun setupPlayer() {
        val options = arrayListOf(
            "--no-drop-late-frames",
            "--no-skip-frames",
            "--file-caching=1200",
            "--network-caching=1200",
        )
        libVlc = LibVLC(this, options)
        mediaPlayer = MediaPlayer(libVlc)
        mediaPlayer.vlcVout.setVideoView(surfaceView)
        mediaPlayer.vlcVout.attachViews()
        mediaPlayer.setEventListener { event ->
            runOnUiThread {
                handlePlayerEvent(event)
            }
        }
    }

    private fun applyLaunchConfig(config: LaunchConfig) {
        currentApiBaseUrl = config.apiBaseUrl
        currentMediaUrl = config.mediaUrl
        sourceText.text = "API ${config.apiBaseUrl} · 房间 ${config.roomSlug}"
        if (config.mediaUrl == null) {
            currentSampleIndex = 0
            playDemoSample(currentSampleIndex)
            return
        }

        currentSampleIndex = -1
        sampleText.text = "外部 URL"
        playUrl(config.mediaUrl)
    }

    private fun playUrl(url: String, sample: DemoMediaSample? = null) {
        currentMediaUrl = url
        setStatus("正在打开媒体")
        sourceText.text = url
        progressText.text = "00:00 / --:--"
        audioTrackText.text = "正在读取音轨"
        logCurrentPlaybackUrl(url, sample)

        if (mediaPlayer.hasMedia()) {
            mediaPlayer.stop()
        }
        val media = Media(libVlc, Uri.parse(url))
        media.setHWDecoderEnabled(true, false)
        media.addOption(":file-caching=1200")
        media.addOption(":network-caching=1200")
        mediaPlayer.setMedia(media)
        media.release()
        mediaPlayer.play()
    }

    private fun playDemoSample(index: Int) {
        currentSampleIndex = Math.floorMod(index, DemoSamplePlaylist.samples.size)
        val sample = DemoSamplePlaylist.samples[currentSampleIndex]
        val url = sample.rawUrl(currentApiBaseUrl)
        sampleText.text = "${sample.displayTitle(currentSampleIndex, DemoSamplePlaylist.samples.size)}\n${sample.technicalSummary()}"
        playUrl(url, sample)
    }

    private fun playNextDemoSample() {
        playDemoSample(DemoSamplePlaylist.nextIndex(currentSampleIndex))
    }

    private fun logCurrentPlaybackUrl(url: String, sample: DemoMediaSample?) {
        if (sample == null) {
            Log.i(TAG, "Playing external mediaUrl=$url")
            return
        }
        Log.i(
            TAG,
            "Playing demo sample ${currentSampleIndex + 1}/${DemoSamplePlaylist.samples.size}: " +
                "${sample.title} - ${sample.artist}; asset=${sample.indexedAssetId}; url=$url",
        )
    }

    private fun togglePlayback() {
        if (!::mediaPlayer.isInitialized || currentMediaUrl == null) {
            setStatus("未加载媒体")
            return
        }

        if (mediaPlayer.isPlaying) {
            mediaPlayer.pause()
            setStatus("已暂停")
        } else {
            mediaPlayer.play()
            setStatus("正在播放")
        }
    }

    private fun seekBy(deltaMs: Long) {
        if (!::mediaPlayer.isInitialized || currentMediaUrl == null) return
        val length = mediaPlayer.length
        val current = mediaPlayer.time
        val next = (current + deltaMs).coerceAtLeast(0L).let { value ->
            if (length > 0) value.coerceAtMost(length) else value
        }
        mediaPlayer.setTime(next, true)
        updateProgress()
    }

    private fun switchAudioTrack(delta: Int) {
        if (!::mediaPlayer.isInitialized || currentMediaUrl == null) {
            setStatus("未加载媒体")
            return
        }

        val tracks = currentVlcAudioTracks()
        if (tracks.isEmpty()) {
            setStatus("未发现可切换音轨")
            refreshAudioTrackText()
            return
        }

        val currentTrackId = mediaPlayer.audioTrack
        val currentIndex = tracks.indexOfFirst { it.id == currentTrackId }.let { if (it >= 0) it else 0 }
        val nextIndex = Math.floorMod(currentIndex + delta, tracks.size)
        val nextTrack = tracks[nextIndex]
        val switched = mediaPlayer.setAudioTrack(nextTrack.id)
        if (switched) {
            val nextTrackOption = AudioTrackOption(id = nextTrack.id, name = nextTrack.name)
            setStatus("已切换音轨：${nextTrackOption.displayName(nextIndex)}")
        } else {
            setStatus("音轨切换失败")
        }
        refreshAudioTrackText()
    }

    private fun handlePlayerEvent(event: MediaPlayer.Event) {
        when (event.type) {
            MediaPlayer.Event.Opening -> setStatus("正在打开媒体")
            MediaPlayer.Event.Buffering -> setStatus("缓冲中 ${event.buffering.toInt()}%")
            MediaPlayer.Event.Playing -> {
                setStatus("正在播放")
                refreshAudioTrackText()
                updateProgress()
            }

            MediaPlayer.Event.Paused -> setStatus("已暂停")
            MediaPlayer.Event.Stopped -> setStatus("已停止")
            MediaPlayer.Event.EndReached -> {
                setStatus("播放结束")
                updateProgress()
            }

            MediaPlayer.Event.EncounteredError -> setStatus("播放失败")
            MediaPlayer.Event.TimeChanged,
            MediaPlayer.Event.LengthChanged -> updateProgress()
            MediaPlayer.Event.ESAdded,
            MediaPlayer.Event.ESDeleted,
            MediaPlayer.Event.ESSelected -> refreshAudioTrackText()
        }
    }

    private fun refreshAudioTrackText() {
        if (!::mediaPlayer.isInitialized) {
            audioTrackText.text = "音轨未加载"
            return
        }

        audioTrackText.text = describeAudioTrackState(currentAudioTrackOptions(), mediaPlayer.audioTrack)
    }

    private fun updateProgress() {
        if (!::mediaPlayer.isInitialized) {
            progressText.text = "--:-- / --:--"
            return
        }

        progressText.text = "${formatDuration(mediaPlayer.time)} / ${formatDuration(mediaPlayer.length)}"
    }

    private fun setStatus(value: String) {
        statusText.text = value
    }

    private fun launchConfigFromIntent(intent: Intent): LaunchConfig {
        val data = intent.data
        return LaunchConfig.from(
            rawApiBaseUrl = intent.getStringExtra(EXTRA_API_BASE_URL) ?: data?.getQueryParameter(EXTRA_API_BASE_URL),
            rawRoom = intent.getStringExtra(EXTRA_ROOM) ?: data?.getQueryParameter(EXTRA_ROOM),
            rawMediaUrl = intent.getStringExtra(EXTRA_MEDIA_URL)
                ?: data?.getQueryParameter(EXTRA_MEDIA_URL)
                ?: data?.asDirectMediaUrl(),
        )
    }

    private fun Uri.asDirectMediaUrl(): String? {
        val scheme = scheme?.lowercase()
        return if (scheme == "http" || scheme == "https") toString() else null
    }

    private fun currentVlcAudioTracks(): List<MediaPlayer.TrackDescription> {
        val rawTracks: Array<MediaPlayer.TrackDescription>? = mediaPlayer.audioTracks
        return rawTracks?.filter { it.id >= 0 }.orEmpty()
    }

    private fun currentAudioTrackOptions(): List<AudioTrackOption>? {
        val rawTracks: Array<MediaPlayer.TrackDescription>? = mediaPlayer.audioTracks
        return rawTracks?.map { AudioTrackOption(id = it.id, name = it.name) }
    }

    private fun formatDuration(valueMs: Long): String {
        if (valueMs <= 0L) return "--:--"
        val totalSeconds = valueMs / 1000L
        val minutes = totalSeconds / 60L
        val seconds = totalSeconds % 60L
        return "%02d:%02d".format(minutes, seconds)
    }

    private fun hideSystemUi() {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            )
    }

    private fun dp(value: Int): Int {
        return (value * resources.displayMetrics.density).toInt()
    }

    companion object {
        private const val TAG = "HomeKTV-TV"
        private const val EXTRA_API_BASE_URL = "apiBaseUrl"
        private const val EXTRA_ROOM = "room"
        private const val EXTRA_MEDIA_URL = "mediaUrl"
    }
}
