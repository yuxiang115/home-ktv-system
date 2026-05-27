package com.liuyue.homektv

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import okhttp3.WebSocket
import org.videolan.libvlc.LibVLC
import org.videolan.libvlc.Media
import org.videolan.libvlc.MediaPlayer
import org.videolan.libvlc.util.VLCVideoLayout

class MainActivity : Activity() {
    private lateinit var videoLayout: VLCVideoLayout
    private lateinit var idleBackgroundImage: ImageView
    private lateinit var bottomPanel: LinearLayout
    private lateinit var idlePairingOverlay: LinearLayout
    private lateinit var idleQrImage: ImageView
    private lateinit var idlePromptText: TextView
    private lateinit var playingQrPanel: LinearLayout
    private lateinit var playingQrImage: ImageView
    private lateinit var progressText: TextView
    private lateinit var audioTrackText: TextView
    private lateinit var nextSampleButton: Button
    private lateinit var libVlc: LibVLC
    private lateinit var mediaPlayer: MediaPlayer

    private val progressHandler = Handler(Looper.getMainLooper())
    private val roomHandler = Handler(Looper.getMainLooper())
    private val progressTicker = object : Runnable {
        override fun run() {
            updateProgress()
            progressHandler.postDelayed(this, 1000)
        }
    }
    private val heartbeatTicker = object : Runnable {
        override fun run() {
            sendHeartbeat()
            roomHandler.postDelayed(this, HEARTBEAT_INTERVAL_MS)
        }
    }
    private val snapshotPoller = object : Runnable {
        override fun run() {
            fetchRoomSnapshot()
            roomHandler.postDelayed(this, SNAPSHOT_POLL_INTERVAL_MS)
        }
    }

    private var config: LaunchConfig = LaunchConfig.from(null, null, null)
    private var currentMediaUrl: String? = null
    private var currentApiBaseUrl: String = ""
    private var currentSampleIndex: Int = 0
    private var playerClient: PlayerApiClient? = null
    private var realtimeSocket: WebSocket? = null
    private var roomModeActive = false
    private var deviceId: String = ""
    private var activeTarget: PlaybackTarget? = null
    private var latestSnapshot: RoomSnapshot? = null
    private var switchInFlight = false
    private var lastRecoveryVersion: Int? = null
    private var selectedTrackKey: String? = null
    private var desiredVolumePercent = DEFAULT_ROOM_VOLUME_PERCENT
    private var renderedQrPayload: String? = null
    private val sentTelemetryKeys = mutableSetOf<String>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        hideSystemUi()

        buildLayout()
        setupPlayer()

        applyLaunchConfig(launchConfigFromIntent(intent))
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
        if (roomModeActive) {
            roomHandler.post(heartbeatTicker)
            roomHandler.post(snapshotPoller)
        }
    }

    override fun onPause() {
        super.onPause()
        progressHandler.removeCallbacks(progressTicker)
        roomHandler.removeCallbacks(heartbeatTicker)
        roomHandler.removeCallbacks(snapshotPoller)
    }

    override fun onDestroy() {
        stopRoomRuntime()
        progressHandler.removeCallbacks(progressTicker)
        if (::mediaPlayer.isInitialized) {
            mediaPlayer.setEventListener(null)
            mediaPlayer.stop()
            mediaPlayer.detachViews()
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
                if (::nextSampleButton.isInitialized && nextSampleButton.visibility == View.VISIBLE && nextSampleButton.isFocused) {
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
                if (roomModeActive) {
                    requestVocalSwitch()
                } else {
                    playNextDemoSample()
                }
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

            KeyEvent.KEYCODE_DPAD_UP,
            KeyEvent.KEYCODE_DPAD_DOWN -> {
                if (roomModeActive) {
                    requestVocalSwitch()
                } else {
                    switchAudioTrack(if (keyCode == KeyEvent.KEYCODE_DPAD_UP) 1 else -1)
                }
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

        videoLayout = VLCVideoLayout(this).apply {
            keepScreenOn = true
        }
        root.addView(
            videoLayout,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )

        idleBackgroundImage = ImageView(this).apply {
            setImageResource(R.drawable.home_ktv_idle_background)
            scaleType = ImageView.ScaleType.CENTER_CROP
            visibility = View.GONE
        }
        root.addView(
            idleBackgroundImage,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )

        buildPairingOverlays(root)

        bottomPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(14), dp(24), dp(16))
            background = roundedBackground(Color.argb(130, 0, 0, 0), dp(8).toFloat())
        }
        root.addView(
            bottomPanel,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM or Gravity.START,
            ).apply {
                leftMargin = dp(24)
                bottomMargin = dp(22)
            },
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
            visibility = View.GONE
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
    }

    private fun buildPairingOverlays(root: FrameLayout) {
        idlePairingOverlay = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(80), dp(54), dp(86), dp(54))
            background = GradientDrawable(
                GradientDrawable.Orientation.LEFT_RIGHT,
                intArrayOf(Color.argb(135, 7, 11, 18), Color.argb(80, 7, 11, 18), Color.argb(12, 7, 11, 18)),
            )
        }
        root.addView(
            idlePairingOverlay,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )

        val leftPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_VERTICAL
        }
        idlePairingOverlay.addView(
            leftPanel,
            LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f),
        )

        leftPanel.addView(TextView(this).apply {
            text = "HomeKTV"
            textSize = 54f
            setTextColor(Color.WHITE)
            includeFontPadding = false
        })
        leftPanel.addView(TextView(this).apply {
            text = "今晚开唱"
            textSize = 24f
            setTextColor(Color.rgb(222, 226, 235))
            setPadding(0, dp(14), 0, dp(34))
            includeFontPadding = false
        })
        leftPanel.addView(buildDecorativeBars())

        val qrPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dp(28), dp(28), dp(28), dp(24))
            background = roundedBackground(Color.WHITE, dp(8).toFloat())
        }
        idlePairingOverlay.addView(
            qrPanel,
            LinearLayout.LayoutParams(dp(344), LinearLayout.LayoutParams.WRAP_CONTENT),
        )

        idleQrImage = ImageView(this).apply {
            setBackgroundColor(Color.WHITE)
            scaleType = ImageView.ScaleType.FIT_CENTER
        }
        qrPanel.addView(idleQrImage, LinearLayout.LayoutParams(dp(276), dp(276)))

        idlePromptText = TextView(this).apply {
            text = "HomeKTV 请扫码点歌"
            textSize = 22f
            gravity = Gravity.CENTER
            setTextColor(Color.rgb(20, 25, 36))
            setPadding(0, dp(18), 0, 0)
            includeFontPadding = false
        }
        qrPanel.addView(
            idlePromptText,
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT),
        )

        playingQrPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dp(8), dp(8), dp(8), dp(8))
            background = roundedBackground(Color.argb(235, 255, 255, 255), dp(6).toFloat())
        }
        root.addView(
            playingQrPanel,
            FrameLayout.LayoutParams(dp(112), dp(112), Gravity.TOP or Gravity.END).apply {
                topMargin = dp(24)
                rightMargin = dp(24)
            },
        )

        playingQrImage = ImageView(this).apply {
            setBackgroundColor(Color.WHITE)
            scaleType = ImageView.ScaleType.FIT_CENTER
        }
        playingQrPanel.addView(playingQrImage, LinearLayout.LayoutParams(dp(96), dp(96)))
    }

    private fun buildDecorativeBars(): LinearLayout {
        val bars = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.BOTTOM
        }
        val colors = listOf(
            Color.rgb(0, 204, 153),
            Color.rgb(255, 205, 64),
            Color.rgb(255, 104, 88),
            Color.rgb(86, 160, 255),
            Color.rgb(255, 255, 255),
        )
        val heights = listOf(48, 86, 128, 72, 104)
        for (index in heights.indices) {
            bars.addView(
                View(this).apply {
                    background = roundedBackground(colors[index], dp(5).toFloat())
                    alpha = if (index == heights.lastIndex) 0.72f else 0.95f
                },
                LinearLayout.LayoutParams(dp(14), dp(heights[index])).apply {
                    rightMargin = dp(12)
                },
            )
        }
        return bars
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
        mediaPlayer.attachViews(videoLayout, null, false, false)
        mediaPlayer.setVideoScale(VideoSurfacePolicy.defaultScaleType)
        applyPlayerVolume(desiredVolumePercent)
        mediaPlayer.setEventListener { event ->
            runOnUiThread {
                handlePlayerEvent(event)
            }
        }
    }

    private fun applyLaunchConfig(config: LaunchConfig) {
        this.config = config
        currentApiBaseUrl = config.apiBaseUrl
        if (config.mediaUrl == null) {
            startRoomMode(config)
            return
        }

        stopRoomRuntime()
        roomModeActive = false
        currentSampleIndex = -1
        nextSampleButton.visibility = View.GONE
        renderPairingOverlay(TvPairingOverlayState.from(roomModeActive = false, snapshot = null))
        playUrl(config.mediaUrl)
    }

    private fun startRoomMode(config: LaunchConfig) {
        stopRoomRuntime(closeSocketOnly = true)
        roomModeActive = true
        activeTarget = null
        latestSnapshot = null
        selectedTrackKey = null
        sentTelemetryKeys.clear()
        currentMediaUrl = null
        if (::mediaPlayer.isInitialized && mediaPlayer.hasMedia()) {
            mediaPlayer.stop()
        }
        nextSampleButton.visibility = View.GONE
        renderPairingOverlay(TvPairingOverlayState.from(roomModeActive = true, snapshot = latestSnapshot))

        val resolved = resolveDeviceId(config)
        deviceId = resolved
        playerClient = PlayerApiClient(config.apiBaseUrl)
        setStatus("正在注册电视")
        progressText.text = "00:00 / --:--"
        audioTrackText.text = "音轨未加载"

        playerClient?.bootstrap(
            roomSlug = config.roomSlug,
            deviceId = deviceId,
            deviceName = config.deviceName,
            callback = uiCallback(
                onSuccess = { result ->
                    setStatus(if (result.status == "conflict") "电视连接冲突" else "电视在线，等待点歌")
                    result.snapshot?.let(::applyRoomSnapshot)
                    openRealtime()
                    roomHandler.removeCallbacks(heartbeatTicker)
                    roomHandler.post(heartbeatTicker)
                    roomHandler.removeCallbacks(snapshotPoller)
                    roomHandler.postDelayed(snapshotPoller, SNAPSHOT_POLL_INTERVAL_MS)
                },
                onError = { error ->
                    setStatus("电视注册失败：${error.shortMessage()}")
                    roomHandler.removeCallbacks(snapshotPoller)
                    roomHandler.postDelayed(snapshotPoller, 1500)
                },
            ),
        )
    }

    private fun resolveDeviceId(config: LaunchConfig): String {
        val preferences = getSharedPreferences(PREFERENCES_NAME, MODE_PRIVATE)
        val resolved = DeviceIdentity.resolve(
            explicitDeviceId = config.deviceId,
            storedDeviceId = preferences.getString(PREFERENCE_DEVICE_ID, null),
        )
        if (resolved.shouldPersist) {
            preferences.edit().putString(PREFERENCE_DEVICE_ID, resolved.deviceId).apply()
        }
        return resolved.deviceId
    }

    private fun openRealtime() {
        val client = playerClient ?: return
        realtimeSocket?.close(1000, "reconnect")
        realtimeSocket = client.openRealtime(
            roomSlug = config.roomSlug,
            deviceId = deviceId,
            listener = object : RoomRealtimeListener {
                override fun onOpen() {
                    runOnUiThread {
                        if (activeTarget == null) {
                            setStatus("电视在线，等待点歌")
                        }
                    }
                }

                override fun onSnapshot(snapshot: RoomSnapshot) {
                    runOnUiThread { applyRoomSnapshot(snapshot) }
                }

                override fun onClosed(reason: String) {
                    runOnUiThread {
                        if (roomModeActive) {
                            setStatus("实时连接已断开，使用轮询")
                        }
                    }
                }

                override fun onError(error: Throwable) {
                    runOnUiThread {
                        if (roomModeActive) {
                            setStatus("实时连接异常，使用轮询：${error.shortMessage()}")
                        }
                    }
                }
            },
        )
    }

    private fun fetchRoomSnapshot() {
        if (!roomModeActive) return
        val client = playerClient ?: return
        client.fetchSnapshot(
            roomSlug = config.roomSlug,
            callback = uiCallback(
                onSuccess = ::applyRoomSnapshot,
                onError = { error ->
                    if (activeTarget == null) {
                        setStatus("房间快照失败：${error.shortMessage()}")
                    }
                },
            ),
        )
    }

    private fun applyRoomSnapshot(snapshot: RoomSnapshot) {
        if (!roomModeActive) return
        latestSnapshot = snapshot
        logRoomSnapshot(snapshot)
        applyPlayerVolume(snapshot.volumePercent)
        renderPairingOverlay(TvPairingOverlayState.from(roomModeActive = true, snapshot = snapshot))

        if (snapshot.state == "recovering" && lastRecoveryVersion != snapshot.sessionVersion) {
            lastRecoveryVersion = snapshot.sessionVersion
            requestReconnectRecovery()
            return
        }

        when (val action = RoomPlaybackDecision.decide(snapshot, activeTarget, switchInFlight)) {
            PlaybackAction.KeepPlaying -> Unit
            PlaybackAction.StopPlayback -> stopActiveRoomPlayback(snapshot)
            is PlaybackAction.PlayNewTarget -> playTarget(action.target)
            PlaybackAction.SwitchVocalMode -> requestVocalSwitch()
        }
    }

    private fun logRoomSnapshot(snapshot: RoomSnapshot) {
        val target = snapshot.currentTarget
        if (target == null) {
            Log.i(TAG, "Room snapshot ${snapshot.sessionVersion}: no current target, state=${snapshot.state}")
            return
        }

        Log.i(
            TAG,
            "Room snapshot ${snapshot.sessionVersion}: " +
                "${target.currentQueueEntryPreview.songTitle} - ${target.currentQueueEntryPreview.artistName}; " +
                "mode=${target.vocalMode}; volume=${snapshot.volumePercent}; " +
                "queue=${target.queueEntryId}; next=${target.nextQueueEntryPreview?.songTitle.orEmpty()}",
        )
    }

    private fun playTarget(target: PlaybackTarget) {
        activeTarget = target
        selectedTrackKey = null
        currentSampleIndex = -1
        nextSampleButton.visibility = View.GONE
        renderPairingOverlay(TvPairingOverlayState.from(roomModeActive = true, snapshot = latestSnapshot))
        playUrl(target.playbackUrl, target = target)
        sendTelemetryOnce(
            target = target,
            eventType = "loading",
            playbackPositionMs = target.resumePositionMs,
            stage = "android_vlc_opening",
        )
    }

    private fun playUrl(url: String, sample: DemoMediaSample? = null, target: PlaybackTarget? = null) {
        currentMediaUrl = url
        setStatus("正在打开媒体")
        progressText.text = "00:00 / --:--"
        audioTrackText.text = "正在读取音轨"
        logCurrentPlaybackUrl(url, sample, target)

        if (mediaPlayer.hasMedia()) {
            mediaPlayer.stop()
        }
        val media = Media(libVlc, Uri.parse(url))
        media.setHWDecoderEnabled(true, false)
        media.addOption(":file-caching=1200")
        media.addOption(":network-caching=1200")
        mediaPlayer.setMedia(media)
        media.release()
        mediaPlayer.setVideoScale(VideoSurfacePolicy.defaultScaleType)
        applyPlayerVolume(desiredVolumePercent)
        mediaPlayer.updateVideoSurfaces()
        val startPosition = target?.resumePositionMs?.coerceAtLeast(0L) ?: 0L
        mediaPlayer.play()
        if (startPosition > 0L) {
            roomHandler.postDelayed({ mediaPlayer.setTime(startPosition, true) }, 500)
        }
    }

    private fun playDemoSample(index: Int) {
        stopRoomRuntime(closeSocketOnly = true)
        roomModeActive = false
        currentSampleIndex = Math.floorMod(index, DemoSamplePlaylist.samples.size)
        val sample = DemoSamplePlaylist.samples[currentSampleIndex]
        val url = sample.rawUrl(currentApiBaseUrl)
        nextSampleButton.visibility = View.GONE
        playUrl(url, sample)
    }

    private fun playNextDemoSample() {
        playDemoSample(DemoSamplePlaylist.nextIndex(currentSampleIndex))
    }

    private fun stopActiveRoomPlayback(snapshot: RoomSnapshot? = latestSnapshot) {
        activeTarget = null
        selectedTrackKey = null
        if (::mediaPlayer.isInitialized && mediaPlayer.hasMedia()) {
            mediaPlayer.stop()
        }
        currentMediaUrl = null
        progressText.text = "00:00 / --:--"
        audioTrackText.text = "音轨未加载"
        if (roomModeActive) {
            renderPairingOverlay(TvPairingOverlayState.from(roomModeActive = true, snapshot = latestSnapshot))
        }
        setStatus(
            when {
                snapshot?.conflict == true || snapshot?.state == "conflict" -> "电视连接冲突"
                roomModeActive -> "电视在线，等待点歌"
                else -> "已停止"
            },
        )
    }

    private fun requestVocalSwitch() {
        if (!roomModeActive || switchInFlight) return
        val target = activeTarget ?: latestSnapshot?.currentTarget ?: return
        val client = playerClient ?: return
        switchInFlight = true
        setStatus("正在切换原唱/伴唱")
        client.requestSwitchTransition(
            roomSlug = config.roomSlug,
            playbackPositionMs = currentPlaybackPositionMs(),
            callback = uiCallback(
                onSuccess = { result ->
                    val switchTarget = result.switchTarget
                    if (result.status != "ready" || switchTarget == null) {
                        switchInFlight = false
                        setStatus("暂无可切换音轨")
                        return@uiCallback
                    }
                    commitSwitchTarget(target, switchTarget)
                },
                onError = { error ->
                    switchInFlight = false
                    setStatus("原唱/伴唱切换失败：${error.shortMessage()}")
                },
            ),
        )
    }

    private fun commitSwitchTarget(previousTarget: PlaybackTarget, switchTarget: SwitchTarget) {
        if (switchTarget.switchKind == "audio_track") {
            val result = selectVlcAudioTrack(switchTarget.selectedTrackRef)
            if (result.status == AudioTrackSwitchStatus.SELECTED) {
                val nextTarget = playbackTargetFromSwitchTarget(switchTarget, previousTarget)
                activeTarget = nextTarget
                selectedTrackKey = nextTarget.selectedTrackRef?.stableKey(nextTarget)
                switchInFlight = false
                setStatus("已切换为 ${switchTarget.vocalMode.displayVocalMode()}")
                refreshAudioTrackText()
                sendSwitchCommittedTelemetry(switchTarget)
                fetchRoomSnapshot()
            } else {
                switchInFlight = false
                setStatus("原唱/伴唱切换失败，已保持当前播放")
                sendSwitchFailedTelemetry(switchTarget, result.message)
            }
            return
        }

        val nextTarget = playbackTargetFromSwitchTarget(switchTarget, previousTarget)
        activeTarget = nextTarget
        selectedTrackKey = null
        playUrl(switchTarget.playbackUrl, target = nextTarget)
        switchInFlight = false
    }

    private fun requestReconnectRecovery() {
        val client = playerClient ?: return
        client.requestReconnectRecovery(
            roomSlug = config.roomSlug,
            deviceId = deviceId,
            callback = uiCallback(
                onSuccess = { result ->
                    result.noticeMessage?.let(::setStatus)
                    result.target?.let(::playTarget)
                },
                onError = { error -> setStatus("恢复播放失败：${error.shortMessage()}") },
            ),
        )
    }

    private fun sendHeartbeat() {
        if (!roomModeActive) return
        val client = playerClient ?: return
        client.sendHeartbeat(
            roomSlug = config.roomSlug,
            deviceId = deviceId,
            currentQueueEntryId = activeTarget?.queueEntryId,
            playbackPositionMs = currentPlaybackPositionMs(),
            health = "ok",
        )
    }

    private fun handlePlayerEvent(event: MediaPlayer.Event) {
        when (event.type) {
            MediaPlayer.Event.Opening -> setStatus("正在打开媒体")
            MediaPlayer.Event.Buffering -> setStatus("缓冲中 ${event.buffering.toInt()}%")
            MediaPlayer.Event.Playing -> {
                applyPendingTrackSelection()
                val target = activeTarget
                setStatus(if (target != null) "正在播放 · ${target.vocalMode.displayVocalMode()}" else "正在播放")
                refreshAudioTrackText()
                updateProgress()
                if (target != null && !switchInFlight) {
                    sendTelemetryOnce(
                        target = target,
                        eventType = "playing",
                        playbackPositionMs = currentPlaybackPositionMs(),
                        stage = "active_playback_started",
                    )
                }
            }

            MediaPlayer.Event.Paused -> setStatus("已暂停")
            MediaPlayer.Event.Stopped -> {
                if (!roomModeActive || activeTarget == null) {
                    setStatus("已停止")
                }
            }

            MediaPlayer.Event.EndReached -> {
                setStatus("播放结束")
                updateProgress()
                activeTarget?.let { target ->
                    sendTelemetryOnce(
                        target = target,
                        eventType = "ended",
                        playbackPositionMs = endedPlaybackPositionMs(),
                        stage = "ended",
                    )
                }
                if (roomModeActive) {
                    roomHandler.postDelayed({ fetchRoomSnapshot() }, 500)
                }
            }

            MediaPlayer.Event.EncounteredError -> {
                setStatus("播放失败")
                activeTarget?.let { target ->
                    sendTelemetryOnce(
                        target = target,
                        eventType = "failed",
                        playbackPositionMs = currentPlaybackPositionMs(),
                        stage = "android_libvlc_error",
                        message = "libVLC playback error",
                        errorCode = "ANDROID_LIBVLC_PLAYBACK_ERROR",
                    )
                }
            }

            MediaPlayer.Event.TimeChanged,
            MediaPlayer.Event.LengthChanged -> updateProgress()
            MediaPlayer.Event.ESAdded,
            MediaPlayer.Event.ESDeleted,
            MediaPlayer.Event.ESSelected -> {
                applyPendingTrackSelection()
                refreshAudioTrackText()
            }
        }
    }

    private fun applyPendingTrackSelection() {
        val target = activeTarget ?: return
        val trackRef = target.selectedTrackRef ?: return
        val key = trackRef.stableKey(target)
        if (selectedTrackKey == key) return

        val result = selectVlcAudioTrack(trackRef)
        if (result.status == AudioTrackSwitchStatus.SELECTED) {
            selectedTrackKey = key
            Log.i(TAG, "Selected audio track for ${target.assetId}: ${result.message}")
        } else if (currentVlcAudioTracks().isNotEmpty()) {
            Log.w(TAG, "Audio track selection failed for ${target.assetId}: ${result.message}")
        }
    }

    private fun selectVlcAudioTrack(trackRef: TrackRef?): AudioTrackSwitchResult {
        if (trackRef == null) {
            return AudioTrackSwitchResult(AudioTrackSwitchStatus.SELECTED, "no track requested")
        }

        val tracks = currentVlcAudioTracks()
        if (tracks.isEmpty()) {
            return AudioTrackSwitchResult(AudioTrackSwitchStatus.UNAVAILABLE, "audio tracks are not loaded")
        }

        val targetTrack = chooseAudioTrackForRef(
            tracks = tracks.map { AudioTrackOption(id = it.id, name = it.name) },
            trackRef = trackRef,
        )

        if (targetTrack == null) {
            return AudioTrackSwitchResult(AudioTrackSwitchStatus.MISSING, "requested audio track is not available")
        }

        val switched = mediaPlayer.setAudioTrack(targetTrack.id)
        return if (switched) {
            AudioTrackSwitchResult(AudioTrackSwitchStatus.SELECTED, "track ${targetTrack.id} ${targetTrack.name.orEmpty()}")
        } else {
            AudioTrackSwitchResult(AudioTrackSwitchStatus.FAILED, "libVLC rejected audio track ${targetTrack.id}")
        }
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

    private fun applyPlayerVolume(volumePercent: Int) {
        val clamped = volumePercent.coerceIn(0, 100)
        desiredVolumePercent = clamped
        if (::mediaPlayer.isInitialized) {
            mediaPlayer.setVolume(clamped)
        }
    }

    private fun sendTelemetryOnce(
        target: PlaybackTarget,
        eventType: String,
        playbackPositionMs: Long,
        stage: String,
        message: String? = null,
        errorCode: String? = null,
    ) {
        val key = listOf(eventType, target.queueEntryId, target.assetId, target.vocalMode, stage).joinToString(":")
        if (!sentTelemetryKeys.add(key)) return
        sendTelemetry(
            eventType = eventType,
            sessionVersion = target.sessionVersion,
            queueEntryId = target.queueEntryId,
            assetId = target.assetId,
            playbackPositionMs = playbackPositionMs,
            vocalMode = target.vocalMode,
            switchFamily = target.switchFamily,
            rollbackAssetId = null,
            stage = stage,
            message = message,
            errorCode = errorCode,
        )
    }

    private fun sendSwitchCommittedTelemetry(switchTarget: SwitchTarget) {
        sendTelemetry(
            eventType = "playing",
            sessionVersion = switchTarget.sessionVersion,
            queueEntryId = switchTarget.queueEntryId,
            assetId = switchTarget.toAssetId,
            playbackPositionMs = currentPlaybackPositionMs(),
            vocalMode = switchTarget.vocalMode,
            switchFamily = switchTarget.switchFamily,
            rollbackAssetId = switchTarget.rollbackAssetId,
            stage = "switch_committed",
        )
    }

    private fun sendSwitchFailedTelemetry(switchTarget: SwitchTarget, message: String) {
        sendTelemetry(
            eventType = "switch_failed",
            sessionVersion = switchTarget.sessionVersion,
            queueEntryId = switchTarget.queueEntryId,
            assetId = switchTarget.toAssetId,
            playbackPositionMs = currentPlaybackPositionMs(),
            vocalMode = activeTarget?.vocalMode ?: switchTarget.vocalMode,
            switchFamily = switchTarget.switchFamily,
            rollbackAssetId = switchTarget.rollbackAssetId,
            stage = "audio_track",
            message = message,
        )
    }

    private fun sendTelemetry(
        eventType: String,
        sessionVersion: Int,
        queueEntryId: String,
        assetId: String,
        playbackPositionMs: Long,
        vocalMode: String,
        switchFamily: String?,
        rollbackAssetId: String?,
        stage: String,
        message: String? = null,
        errorCode: String? = null,
    ) {
        val client = playerClient ?: return
        if (!roomModeActive) return
        client.sendTelemetry(
            roomSlug = config.roomSlug,
            deviceId = deviceId,
            eventType = eventType,
            sessionVersion = sessionVersion,
            queueEntryId = queueEntryId,
            assetId = assetId,
            playbackPositionMs = playbackPositionMs,
            vocalMode = vocalMode,
            switchFamily = switchFamily,
            rollbackAssetId = rollbackAssetId,
            stage = stage,
            message = message,
            errorCode = errorCode,
        )
    }

    private fun playbackTargetFromSwitchTarget(target: SwitchTarget, previousTarget: PlaybackTarget): PlaybackTarget {
        return PlaybackTarget(
            roomId = target.roomId,
            sessionVersion = target.sessionVersion,
            queueEntryId = target.queueEntryId,
            assetId = target.toAssetId,
            currentQueueEntryPreview = previousTarget.currentQueueEntryPreview,
            playbackUrl = target.playbackUrl,
            resumePositionMs = target.resumePositionMs,
            vocalMode = target.vocalMode,
            switchFamily = target.switchFamily,
            playbackProfile = target.playbackProfile ?: previousTarget.playbackProfile,
            selectedTrackRef = target.selectedTrackRef,
            nextQueueEntryPreview = previousTarget.nextQueueEntryPreview,
        )
    }

    private fun logCurrentPlaybackUrl(url: String, sample: DemoMediaSample?, target: PlaybackTarget?) {
        when {
            target != null -> Log.i(
                TAG,
                "Playing room target: ${target.currentQueueEntryPreview.songTitle} - " +
                    "${target.currentQueueEntryPreview.artistName}; queue=${target.queueEntryId}; asset=${target.assetId}; url=$url",
            )

            sample != null -> Log.i(
                TAG,
                "Playing demo sample ${currentSampleIndex + 1}/${DemoSamplePlaylist.samples.size}: " +
                    "${sample.title} - ${sample.artist}; asset=${sample.indexedAssetId}; url=$url",
            )

            else -> Log.i(TAG, "Playing external mediaUrl=$url")
        }
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

    private fun refreshAudioTrackText() {
        if (!::mediaPlayer.isInitialized) {
            audioTrackText.text = "音轨未加载"
            return
        }

        audioTrackText.text = describeAudioTrackState(
            rawTracks = currentAudioTrackOptions(),
            currentTrackId = mediaPlayer.audioTrack,
            vocalMode = activeTarget?.vocalMode,
        )
    }

    private fun updateProgress() {
        if (!::mediaPlayer.isInitialized) {
            progressText.text = "--:-- / --:--"
            return
        }

        progressText.text = "${formatDuration(mediaPlayer.time)} / ${formatDuration(mediaPlayer.length)}"
    }

    private fun currentPlaybackPositionMs(): Long {
        if (!::mediaPlayer.isInitialized) return 0L
        return mediaPlayer.time.coerceAtLeast(0L)
    }

    private fun endedPlaybackPositionMs(): Long {
        val length = if (::mediaPlayer.isInitialized) mediaPlayer.length else 0L
        return if (length > 0L) length else currentPlaybackPositionMs()
    }

    private fun setStatus(value: String) {
        Log.i(TAG, value)
    }

    private fun renderPairingOverlay(state: TvPairingOverlayState) {
        idleBackgroundImage.visibility = if (state.showIdleBackground) View.VISIBLE else View.GONE
        bottomPanel.visibility = if (state.showPlaybackHud) View.VISIBLE else View.GONE
        idlePairingOverlay.visibility = if (state.showIdlePairing) View.VISIBLE else View.GONE
        playingQrPanel.visibility = if (state.showPlayingQr) View.VISIBLE else View.GONE

        val payload = state.qrPayload
        if (payload.isNullOrBlank()) {
            idleQrImage.setImageBitmap(null)
            playingQrImage.setImageBitmap(null)
            idlePromptText.text = "HomeKTV 正在准备点歌码"
            renderedQrPayload = null
            return
        }

        idlePromptText.text = "HomeKTV 请扫码点歌"
        if (renderedQrPayload == payload) {
            return
        }

        renderedQrPayload = payload
        idleQrImage.setImageBitmap(QrCodeBitmap.create(payload, dp(276)))
        playingQrImage.setImageBitmap(QrCodeBitmap.create(payload, dp(96)))
    }

    private fun launchConfigFromIntent(intent: Intent): LaunchConfig {
        val data = intent.data
        return LaunchConfig.from(
            rawApiBaseUrl = intent.getStringExtra(EXTRA_API_BASE_URL) ?: data?.getQueryParameter(EXTRA_API_BASE_URL),
            rawRoom = intent.getStringExtra(EXTRA_ROOM) ?: data?.getQueryParameter(EXTRA_ROOM),
            rawMediaUrl = intent.getStringExtra(EXTRA_MEDIA_URL)
                ?: data?.getQueryParameter(EXTRA_MEDIA_URL)
                ?: data?.asDirectMediaUrl(),
            rawDeviceId = intent.getStringExtra(EXTRA_DEVICE_ID) ?: data?.getQueryParameter(EXTRA_DEVICE_ID),
            rawDeviceName = intent.getStringExtra(EXTRA_DEVICE_NAME) ?: data?.getQueryParameter(EXTRA_DEVICE_NAME),
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

    private fun stopRoomRuntime(closeSocketOnly: Boolean = false) {
        roomHandler.removeCallbacks(heartbeatTicker)
        roomHandler.removeCallbacks(snapshotPoller)
        realtimeSocket?.close(1000, "stop room runtime")
        realtimeSocket = null
        if (!closeSocketOnly) {
            roomModeActive = false
        }
    }

    private fun <T> uiCallback(
        onSuccess: (T) -> Unit,
        onError: (Throwable) -> Unit = { error -> setStatus(error.shortMessage()) },
    ): ResultCallback<T> {
        return object : ResultCallback<T> {
            override fun onSuccess(value: T) {
                runOnUiThread { onSuccess(value) }
            }

            override fun onError(error: Throwable) {
                runOnUiThread { onError(error) }
            }
        }
    }

    private fun Throwable.shortMessage(): String {
        return message?.take(120) ?: javaClass.simpleName
    }

    private fun TrackRef.stableKey(target: PlaybackTarget): String {
        return "${target.assetId}:${target.queueEntryId}:${target.vocalMode}:$index:$id"
    }

    private fun String.displayVocalMode(): String {
        return when (this) {
            "original" -> "原唱"
            "instrumental" -> "伴唱"
            "dual" -> "双轨"
            else -> "未知"
        }
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

    private fun roundedBackground(color: Int, radius: Float): GradientDrawable {
        return GradientDrawable().apply {
            setColor(color)
            cornerRadius = radius
        }
    }

    companion object {
        private const val TAG = "HomeKTV-TV"
        private const val EXTRA_API_BASE_URL = "apiBaseUrl"
        private const val EXTRA_ROOM = "room"
        private const val EXTRA_MEDIA_URL = "mediaUrl"
        private const val EXTRA_DEVICE_ID = "deviceId"
        private const val EXTRA_DEVICE_NAME = "deviceName"
        private const val PREFERENCES_NAME = "homektv-tv"
        private const val PREFERENCE_DEVICE_ID = "device-id"
        private const val HEARTBEAT_INTERVAL_MS = 10_000L
        private const val SNAPSHOT_POLL_INTERVAL_MS = 5_000L
    }
}

private enum class AudioTrackSwitchStatus {
    SELECTED,
    UNAVAILABLE,
    MISSING,
    FAILED,
}

private data class AudioTrackSwitchResult(
    val status: AudioTrackSwitchStatus,
    val message: String,
)
