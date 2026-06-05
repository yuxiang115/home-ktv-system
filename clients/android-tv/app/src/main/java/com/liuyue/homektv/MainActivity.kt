package com.liuyue.homektv

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.util.Log
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import android.view.animation.LinearInterpolator
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import com.jawnnypoo.physicslayout.Physics
import com.jawnnypoo.physicslayout.PhysicsConfig
import com.jawnnypoo.physicslayout.PhysicsFrameLayout
import com.jawnnypoo.physicslayout.Shape
import okhttp3.WebSocket
import org.jbox2d.common.Vec2
import org.jbox2d.dynamics.BodyDef
import org.jbox2d.dynamics.BodyType
import org.jbox2d.dynamics.FixtureDef
import org.videolan.libvlc.LibVLC
import org.videolan.libvlc.Media
import org.videolan.libvlc.MediaPlayer
import org.videolan.libvlc.util.VLCVideoLayout

class MainActivity : Activity() {
    private lateinit var videoLayout: VLCVideoLayout
    private lateinit var idleBackgroundImage: ImageView
    private lateinit var interactionLayer: FrameLayout
    private lateinit var emojiPhysicsLayer: PhysicsFrameLayout
    private lateinit var bottomPanel: LinearLayout
    private lateinit var idlePairingOverlay: LinearLayout
    private lateinit var idleQrImage: ImageView
    private lateinit var idlePromptText: TextView
    private lateinit var idleStatusDot: View
    private lateinit var idleStatusText: TextView
    private lateinit var playingQrPanel: LinearLayout
    private lateinit var playingQrImage: ImageView
    private lateinit var statusBanner: LinearLayout
    private lateinit var statusPillText: TextView
    private lateinit var statusMessageText: TextView
    private lateinit var progressText: TextView
    private lateinit var vocalModeText: TextView
    private lateinit var audioTrackText: TextView
    private lateinit var playbackStateText: TextView
    private lateinit var nextSampleButton: Button
    private lateinit var libVlc: LibVLC
    private lateinit var mediaPlayer: MediaPlayer

    private val progressHandler = Handler(Looper.getMainLooper())
    private val roomHandler = Handler(Looper.getMainLooper())
    private val statusHandler = Handler(Looper.getMainLooper())
    private val interactionHandler = Handler(Looper.getMainLooper())
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
    private val hideStatusNoticeRunnable = Runnable { hideStatusNotice() }

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
    private var renderedNoticeMessage: String? = null
    private var suppressReplacementTerminalEvents = false
    private val playbackErrorRecovery = PlaybackErrorRecovery(
        maxRetriesPerQueueEntry = PLAYBACK_ERROR_RECOVERY_RETRIES,
        rewindMs = PLAYBACK_ERROR_RECOVERY_REWIND_MS,
    )
    private val sentTelemetryKeys = mutableSetOf<String>()
    private val blessingInteractions = linkedMapOf<String, Pair<RoomInteractionEvent, View>>()
    private val rainbowPraiseCards = linkedMapOf<String, View>()

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
        statusHandler.removeCallbacksAndMessages(null)
        interactionHandler.removeCallbacksAndMessages(null)
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
            background = GradientDrawable(
                GradientDrawable.Orientation.TL_BR,
                intArrayOf(Color.rgb(5, 7, 13), Color.rgb(11, 16, 32), Color.BLACK),
            )
            keepScreenOn = true
            clipChildren = false
            clipToPadding = false
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

        interactionLayer = FrameLayout(this).apply {
            isClickable = false
            isFocusable = false
            clipChildren = false
            clipToPadding = false
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        root.addView(
            interactionLayer,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )
        installEmojiPhysicsLayer()

        buildPairingOverlays(root)
        buildStatusBanner(root)

        bottomPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(14), dp(20), dp(15))
            background = panelBackground(
                color = Color.argb(150, 0, 0, 0),
                radius = dp(8).toFloat(),
                strokeColor = Color.argb(58, 148, 163, 184),
            )
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
            textSize = 32f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.rgb(248, 250, 252))
            includeFontPadding = false
        }
        bottomPanel.addView(progressText)

        val metaRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(8), 0, 0)
        }
        bottomPanel.addView(metaRow)

        vocalModeText = TextView(this).apply {
            textSize = 18f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.rgb(34, 211, 238))
            includeFontPadding = false
        }
        metaRow.addView(vocalModeText)

        audioTrackText = TextView(this).apply {
            textSize = 18f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.rgb(203, 213, 225))
            includeFontPadding = false
            maxWidth = dp(420)
            ellipsize = TextUtils.TruncateAt.END
            setSingleLine(true)
        }
        metaRow.addView(
            audioTrackText,
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                leftMargin = dp(10)
            },
        )

        playbackStateText = TextView(this).apply {
            textSize = 18f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.rgb(52, 211, 153))
            includeFontPadding = false
        }
        metaRow.addView(
            playbackStateText,
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                leftMargin = dp(10)
            },
        )

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

        interactionLayer.bringToFront()
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
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.WHITE)
            includeFontPadding = false
        })
        leftPanel.addView(TextView(this).apply {
            text = "今晚开唱"
            textSize = 24f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.rgb(222, 226, 235))
            setPadding(0, dp(14), 0, dp(34))
            includeFontPadding = false
        })
        leftPanel.addView(buildDecorativeBars())
        leftPanel.addView(
            buildIdleStatusPill(),
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(36)
            },
        )

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

    private fun buildIdleStatusPill(): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(18), dp(13), dp(18), dp(13))
            background = panelBackground(
                color = Color.argb(142, 15, 23, 42),
                radius = dp(999).toFloat(),
                strokeColor = Color.argb(62, 148, 163, 184),
            )

            idleStatusDot = View(this@MainActivity).apply {
                background = roundedBackground(Color.rgb(52, 211, 153), dp(999).toFloat())
            }
            addView(idleStatusDot, LinearLayout.LayoutParams(dp(10), dp(10)))

            idleStatusText = TextView(this@MainActivity).apply {
                text = "电视已连接"
                textSize = 20f
                typeface = Typeface.DEFAULT_BOLD
                setTextColor(Color.rgb(248, 250, 252))
                includeFontPadding = false
            }
            addView(
                idleStatusText,
                LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                    leftMargin = dp(10)
                },
            )
        }
    }

    private fun buildStatusBanner(root: FrameLayout) {
        statusBanner = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(18), dp(12), dp(20), dp(12))
            background = panelBackground(
                color = Color.argb(210, 15, 23, 42),
                radius = dp(999).toFloat(),
                strokeColor = Color.argb(62, 148, 163, 184),
            )
            alpha = 0f
            visibility = View.GONE
        }
        root.addView(
            statusBanner,
            FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.START).apply {
                topMargin = dp(24)
                leftMargin = dp(24)
            },
        )

        statusPillText = TextView(this).apply {
            textSize = 14f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.rgb(251, 191, 36))
            includeFontPadding = false
            setPadding(dp(12), dp(8), dp(12), dp(8))
            background = statusPillBackground(TvStatusTone.WARNING)
        }
        statusBanner.addView(statusPillText)

        statusMessageText = TextView(this).apply {
            textSize = 20f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.rgb(248, 250, 252))
            includeFontPadding = false
            maxWidth = dp(620)
            ellipsize = TextUtils.TruncateAt.END
            setSingleLine(true)
        }
        statusBanner.addView(
            statusMessageText,
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                leftMargin = dp(18)
            },
        )
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
        clearRoomInteractions()
        activeTarget = null
        latestSnapshot = null
        selectedTrackKey = null
        renderedNoticeMessage = null
        sentTelemetryKeys.clear()
        playbackErrorRecovery.clear()
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
        refreshAudioTrackText()

        playerClient?.bootstrap(
            roomSlug = config.roomSlug,
            deviceId = deviceId,
            deviceName = config.deviceName,
            callback = uiCallback(
                onSuccess = { result ->
                    setStatus("电视在线，等待点歌")
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

                override fun onInteraction(interaction: RoomInteractionEvent) {
                    runOnUiThread { renderRoomInteraction(interaction) }
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
        renderSnapshotNotice(snapshot.noticeMessage)
        renderPairingOverlay(TvPairingOverlayState.from(roomModeActive = true, snapshot = snapshot))

        if (snapshot.state == "recovering" && lastRecoveryVersion != snapshot.sessionVersion) {
            lastRecoveryVersion = snapshot.sessionVersion
            requestReconnectRecovery()
            return
        }

        val action = RoomPlaybackDecision.decide(snapshot, activeTarget, switchInFlight)
        logSnapshotDecision(snapshot, action)
        when (action) {
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
                "queue=${target.queueEntryId}; source=${target.sourceType}; next=${target.nextQueueEntryPreview?.songTitle.orEmpty()}",
        )
    }

    private fun renderSnapshotNotice(message: String?) {
        if (message.isNullOrBlank()) {
            renderedNoticeMessage = null
            return
        }
        if (renderedNoticeMessage == message) {
            return
        }
        renderedNoticeMessage = message
        setStatus(message)
    }

    private fun playTarget(target: PlaybackTarget) {
        Log.i(TAG, "Play target: ${target.diagnosticLabel()} resume=${target.resumePositionMs}ms")
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
        refreshAudioTrackText()
        logCurrentPlaybackUrl(url, sample, target)

        if (mediaPlayer.hasMedia()) {
            suppressReplacementTerminalEvents = true
            roomHandler.postDelayed({ suppressReplacementTerminalEvents = false }, MEDIA_REPLACEMENT_SUPPRESSION_MS)
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
        clearRoomInteractions()
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
        Log.w(
            TAG,
            "Stop room playback: state=${snapshot?.state} conflict=${snapshot?.conflict} " +
                "active=${activeTarget?.diagnosticLabel()} pos=${currentPlaybackPositionMs()}ms",
        )
        activeTarget = null
        selectedTrackKey = null
        renderedNoticeMessage = null
        if (::mediaPlayer.isInitialized && mediaPlayer.hasMedia()) {
            mediaPlayer.stop()
        }
        currentMediaUrl = null
        progressText.text = "00:00 / --:--"
        refreshAudioTrackText()
        if (roomModeActive) {
            renderPairingOverlay(TvPairingOverlayState.from(roomModeActive = true, snapshot = latestSnapshot))
        }
        setStatus(
            when {
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
        logPlayerEvent(event)
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
                if (consumeSuppressedReplacementTerminalEvent("ended")) {
                    return
                }
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
                if (consumeSuppressedReplacementTerminalEvent("failed")) {
                    return
                }
                if (recoverFromPlaybackError()) {
                    return
                }
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

    private fun recoverFromPlaybackError(): Boolean {
        val target = activeTarget ?: return false
        val retryPosition = playbackErrorRecovery.nextRetryPosition(
            queueEntryId = target.queueEntryId,
            currentPositionMs = currentPlaybackPositionMs(),
        ) ?: return false

        setStatus("播放异常，正在恢复")
        Log.w(TAG, "Recover playback error: target=${target.diagnosticLabel()} retryFrom=${retryPosition}ms")
        playUrl(target.playbackUrl, target = target.copy(resumePositionMs = retryPosition))
        return true
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
        val key = listOf(eventType, target.queueEntryId, target.sourceType, target.assetId, target.vocalMode, stage).joinToString(":")
        if (!sentTelemetryKeys.add(key)) {
            Log.i(TAG, "Skip duplicate telemetry: event=$eventType stage=$stage target=${target.diagnosticLabel()}")
            return
        }
        sendTelemetry(
            eventType = eventType,
            sessionVersion = target.sessionVersion,
            queueEntryId = target.queueEntryId,
            sourceType = target.sourceType,
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
            sourceType = switchTarget.sourceType,
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
            sourceType = switchTarget.sourceType,
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
        sourceType: String,
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
        Log.i(
            TAG,
            "Send telemetry: event=$eventType stage=$stage session=$sessionVersion " +
                "queue=$queueEntryId asset=$assetId pos=${playbackPositionMs}ms mode=$vocalMode " +
                "message=${message.orEmpty()} error=${errorCode.orEmpty()}",
        )
        client.sendTelemetry(
            roomSlug = config.roomSlug,
            deviceId = deviceId,
            eventType = eventType,
            sessionVersion = sessionVersion,
            queueEntryId = queueEntryId,
            sourceType = sourceType,
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
            sourceType = target.sourceType,
            songId = previousTarget.songId,
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
                    "${target.currentQueueEntryPreview.artistName}; queue=${target.queueEntryId}; source=${target.sourceType}; asset=${target.assetId}; url=$url",
            )

            sample != null -> Log.i(
                TAG,
                "Playing demo sample ${currentSampleIndex + 1}/${DemoSamplePlaylist.samples.size}: " +
                    "${sample.title} - ${sample.artist}; asset=${sample.indexedAssetId}; url=$url",
            )

            else -> Log.i(TAG, "Playing external mediaUrl=$url")
        }
    }

    private fun logSnapshotDecision(snapshot: RoomSnapshot, action: PlaybackAction) {
        Log.i(
            TAG,
            "Snapshot decision: version=${snapshot.sessionVersion} state=${snapshot.state} " +
                "action=${action.diagnosticLabel()} active=${activeTarget?.diagnosticLabel() ?: "none"} " +
                "target=${snapshot.currentTarget?.diagnosticLabel() ?: "none"} " +
                "switchInFlight=$switchInFlight playerPos=${currentPlaybackPositionMs()}ms",
        )
    }

    private fun logPlayerEvent(event: MediaPlayer.Event) {
        if (event.type == MediaPlayer.Event.TimeChanged) return
        Log.i(
            TAG,
            "VLC event: ${vlcEventName(event.type)} buffering=${event.buffering.toInt()} " +
                "target=${activeTarget?.diagnosticLabel() ?: "none"} pos=${currentPlaybackPositionMs()}ms " +
                "len=${if (::mediaPlayer.isInitialized) mediaPlayer.length else 0L}ms " +
                "isPlaying=${::mediaPlayer.isInitialized && mediaPlayer.isPlaying} " +
                "hasMedia=${::mediaPlayer.isInitialized && mediaPlayer.hasMedia()} " +
                "switchInFlight=$switchInFlight suppressReplacement=$suppressReplacementTerminalEvents",
        )
    }

    private fun PlaybackAction.diagnosticLabel(): String {
        return when (this) {
            PlaybackAction.KeepPlaying -> "keep"
            PlaybackAction.StopPlayback -> "stop"
            PlaybackAction.SwitchVocalMode -> "switch_vocal"
            is PlaybackAction.PlayNewTarget -> "play_new:${target.queueEntryId}/${target.assetId}"
        }
    }

    private fun PlaybackTarget.diagnosticLabel(): String {
        return "${currentQueueEntryPreview.songTitle}-${currentQueueEntryPreview.artistName} queue=$queueEntryId asset=$assetId source=$sourceType mode=$vocalMode"
    }

    private fun vlcEventName(type: Int): String {
        return when (type) {
            MediaPlayer.Event.Opening -> "Opening"
            MediaPlayer.Event.Buffering -> "Buffering"
            MediaPlayer.Event.Playing -> "Playing"
            MediaPlayer.Event.Paused -> "Paused"
            MediaPlayer.Event.Stopped -> "Stopped"
            MediaPlayer.Event.EndReached -> "EndReached"
            MediaPlayer.Event.EncounteredError -> "EncounteredError"
            MediaPlayer.Event.TimeChanged -> "TimeChanged"
            MediaPlayer.Event.LengthChanged -> "LengthChanged"
            MediaPlayer.Event.ESAdded -> "ESAdded"
            MediaPlayer.Event.ESDeleted -> "ESDeleted"
            MediaPlayer.Event.ESSelected -> "ESSelected"
            else -> "Event$type"
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
        if (::vocalModeText.isInitialized) {
            val vocalMode = activeTarget?.vocalMode
            vocalModeText.text = vocalMode?.displayVocalMode() ?: if (roomModeActive) "待点歌" else "本地播放"
            vocalModeText.setTextColor(vocalModeColor(vocalMode))
        }

        if (::playbackStateText.isInitialized) {
            playbackStateText.text = playbackStateLabelForRefresh(
                currentLabel = playbackStateText.text.toString(),
                roomModeActive = roomModeActive,
                hasActiveTarget = activeTarget != null,
                hasCurrentMedia = currentMediaUrl != null,
                isPlayerPlaying = ::mediaPlayer.isInitialized && mediaPlayer.isPlaying,
            )
            playbackStateText.setTextColor(playbackStateColor(playbackStateText.text.toString()))
        }

        if (!::mediaPlayer.isInitialized) {
            audioTrackText.text = "音轨未加载"
            return
        }

        val audioTrackLabel = describeAudioTrackState(
            rawTracks = currentAudioTrackOptions(),
            currentTrackId = mediaPlayer.audioTrack,
            vocalMode = null,
        )
        audioTrackText.text = if (audioTrackLabel == "音轨未加载" && currentMediaUrl != null) {
            "正在读取音轨"
        } else {
            audioTrackLabel
        }
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
        updateIdleStatus(value)
        updatePlaybackState(value)

        val notice = tvStatusNoticeFor(value)
        if (notice == null) {
            if (shouldClearStatusNotice(value)) {
                hideStatusNotice()
            }
            return
        }

        showStatusNotice(notice)
    }

    private fun updateIdleStatus(value: String) {
        if (!::idleStatusText.isInitialized) return
        val label = idleStatusLabelFor(value) ?: return
        idleStatusText.text = label
        idleStatusDot.background = roundedBackground(idleStatusDotColor(label), dp(999).toFloat())
    }

    private fun updatePlaybackState(value: String) {
        if (!::playbackStateText.isInitialized) return
        val label = playbackStateLabelForStatus(
            value = value,
            roomModeActive = roomModeActive,
            currentLabel = playbackStateText.text.toString(),
        ) ?: playbackStateLabel()
        playbackStateText.text = label
        playbackStateText.setTextColor(playbackStateColor(label))
    }

    private fun consumeSuppressedReplacementTerminalEvent(kind: String): Boolean {
        if (!suppressReplacementTerminalEvents) {
            return false
        }
        suppressReplacementTerminalEvents = false
        Log.i(TAG, "Ignored stale libVLC $kind event during media replacement")
        return true
    }

    private fun showStatusNotice(notice: TvStatusNotice) {
        if (!::statusBanner.isInitialized) return
        statusHandler.removeCallbacks(hideStatusNoticeRunnable)
        statusPillText.text = notice.label
        statusPillText.setTextColor(toneColor(notice.tone))
        statusPillText.background = statusPillBackground(notice.tone)
        statusMessageText.text = notice.message
        statusBanner.visibility = View.VISIBLE
        statusBanner.animate().cancel()
        statusBanner.alpha = 0f
        statusBanner.animate().alpha(1f).setDuration(160L).start()
        statusHandler.postDelayed(hideStatusNoticeRunnable, notice.durationMs)
    }

    private fun hideStatusNotice() {
        if (!::statusBanner.isInitialized || statusBanner.visibility != View.VISIBLE) return
        statusHandler.removeCallbacks(hideStatusNoticeRunnable)
        statusBanner.animate().cancel()
        statusBanner.animate().alpha(0f).setDuration(160L).withEndAction {
            statusBanner.visibility = View.GONE
        }.start()
    }

    private fun renderRoomInteraction(interaction: RoomInteractionEvent) {
        if (!roomModeActive || !::interactionLayer.isInitialized) return
        Log.i(TAG, "Room interaction ${interaction.kind}: ${interaction.message.take(24)}")
        interactionLayer.bringToFront()
        when (interaction.kind) {
            "emoji" -> renderEmojiInteraction(interaction)
            "bullet" -> renderBulletInteraction(interaction)
            "rainbow_praise" -> renderRainbowPraiseInteraction(interaction)
            "roast" -> renderBulletInteraction(interaction)
            "blessing" -> renderBlessingInteraction(interaction)
        }
    }

    private fun renderEmojiInteraction(interaction: RoomInteractionEvent) {
        val physicsLayer = ensureEmojiPhysicsLayer()
        physicsLayer.post {
            val layerWidth = physicsLayer.width.coerceAtLeast(dp(720))
            val layerHeight = physicsLayer.height.coerceAtLeast(dp(420))
            val size = dp(104)
            val plan = emojiPhysicsLaunchPlan(
                id = interaction.id,
                layerWidth = layerWidth,
                layerHeight = layerHeight,
                size = size,
                margin = dp(96),
            )
            val seed = stableHash(interaction.id)
            val ttl = interactionTtlFor(interaction, fallbackMs = 12_000L)

            val emojiView = TextView(this).apply {
                id = View.generateViewId()
                text = interaction.message
                textSize = 58f
                gravity = Gravity.CENTER
                includeFontPadding = false
                background = roundedBackground(Color.argb(78, 15, 23, 42), dp(999).toFloat())
                elevation = dp(10).toFloat()
                rotation = plan.initialRotation
                scaleX = 0.86f
                scaleY = 0.86f
            }
            Physics.setPhysicsConfig(emojiView, createEmojiPhysicsConfig())
            physicsLayer.addView(
                emojiView,
                FrameLayout.LayoutParams(size, size).apply {
                    leftMargin = plan.left
                    topMargin = plan.top
                },
            )

            renderEmojiConfetti(plan.left + size / 2, plan.top + size - dp(8), seed)
            launchEmojiPhysicsBody(physicsLayer, emojiView, plan)
            emojiView.animate()
                .scaleX(1f)
                .scaleY(1f)
                .setDuration(520L)
                .setInterpolator(DecelerateInterpolator())
                .start()
            fadeOutAndRemoveViewLater(emojiView, ttl)
        }
    }

    private fun installEmojiPhysicsLayer() {
        val tuning = emojiPhysicsTuning()
        emojiPhysicsLayer = PhysicsFrameLayout(this).apply {
            isClickable = false
            isFocusable = false
            clipChildren = false
            clipToPadding = false
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            physics.isFlingEnabled = false
            physics.hasBounds = true
            physics.pixelsPerMeter = dp(tuning.pixelsPerMeter.toInt()).toFloat()
            physics.velocityIterations = 8
            physics.positionIterations = 4
            physics.setGravityY(tuning.gravityY)
            addOnLayoutChangeListener(object : View.OnLayoutChangeListener {
                override fun onLayoutChange(
                    v: View,
                    left: Int,
                    top: Int,
                    right: Int,
                    bottom: Int,
                    oldLeft: Int,
                    oldTop: Int,
                    oldRight: Int,
                    oldBottom: Int,
                ) {
                    if (right <= left || bottom <= top || physics.world == null) {
                        return
                    }
                    removeOnLayoutChangeListener(this)
                    physics.setBoundsSize(28f)
                }
            })
        }
        interactionLayer.addView(
            emojiPhysicsLayer,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )
    }

    private fun ensureEmojiPhysicsLayer(): PhysicsFrameLayout {
        if (!::emojiPhysicsLayer.isInitialized || emojiPhysicsLayer.parent !== interactionLayer) {
            installEmojiPhysicsLayer()
        }
        return emojiPhysicsLayer
    }

    private fun createEmojiPhysicsConfig(): PhysicsConfig {
        val tuning = emojiPhysicsTuning()
        return PhysicsConfig(
            shape = Shape.CIRCLE,
            fixtureDef = FixtureDef().apply {
                density = tuning.density
                friction = tuning.friction
                restitution = tuning.restitution
            },
            bodyDef = BodyDef().apply {
                type = BodyType.DYNAMIC
                linearDamping = tuning.linearDamping
                angularDamping = tuning.angularDamping
            },
        )
    }

    private fun launchEmojiPhysicsBody(
        physicsLayer: PhysicsFrameLayout,
        view: View,
        plan: EmojiPhysicsLaunchPlan,
        attempt: Int = 0,
    ) {
        physicsLayer.post {
            val body = physicsLayer.physics.findBodyById(view.id)
            if (body == null) {
                if (attempt < 5) {
                    physicsLayer.requestLayout()
                    launchEmojiPhysicsBody(physicsLayer, view, plan, attempt + 1)
                }
                return@post
            }
            val pixelsPerMeter = physicsLayer.physics.pixelsPerMeter.takeIf { it > 0f }
                ?: dp(emojiPhysicsTuning().pixelsPerMeter.toInt()).toFloat()
            body.linearVelocity = Vec2(plan.initialVelocityX / pixelsPerMeter, plan.initialVelocityY / pixelsPerMeter)
            body.angularVelocity = plan.angularVelocity
            body.isAwake = true
        }
    }

    private fun renderEmojiConfetti(originX: Int, originY: Int, seed: Int) {
        val colors = intArrayOf(
            Color.rgb(34, 211, 238),
            Color.rgb(52, 211, 153),
            Color.rgb(251, 191, 36),
            Color.rgb(244, 114, 182),
            Color.rgb(248, 250, 252),
        )
        repeat(12) { index ->
            val particle = View(this).apply {
                background = roundedBackground(colors[index % colors.size], dp(2).toFloat())
                rotation = ((seed + index * 31) % 180).toFloat()
            }
            interactionLayer.addView(
                particle,
                FrameLayout.LayoutParams(dp(8 + index % 3 * 3), dp(16 + index % 4 * 3)).apply {
                    leftMargin = originX
                    topMargin = originY
                },
            )
            val direction = if (index % 2 == 0) 1 else -1
            val travelX = direction * dp(42 + (seed + index * 19) % 130).toFloat()
            val travelY = -dp(72 + (seed + index * 23) % 150).toFloat()
            particle.animate()
                .translationX(travelX)
                .translationY(travelY)
                .rotationBy(direction * 210f)
                .alpha(0f)
                .setDuration((820 + index * 28).toLong())
                .setInterpolator(DecelerateInterpolator())
                .withEndAction { interactionLayer.removeView(particle) }
                .start()
        }
    }

    private fun renderRainbowPraiseInteraction(interaction: RoomInteractionEvent) {
        interactionLayer.post {
            val layerWidth = interactionLayer.width.coerceAtLeast(dp(720))
            val layerHeight = interactionLayer.height.coerceAtLeast(dp(420))
            val seed = stableHash(interaction.id)
            val estimatedCardHeight = dp(170)
            rainbowPraiseCards.remove(interaction.id)?.let { existingView ->
                interactionLayer.removeView(existingView)
            }
            val cardTopMargin = rainbowPraiseTopMargin(
                id = interaction.id,
                layerHeight = layerHeight,
                cardHeight = estimatedCardHeight,
                minTop = dp(96),
                maxTop = (layerHeight - estimatedCardHeight - dp(96)).coerceAtLeast(dp(96)),
                existing = currentRainbowPraiseBounds(estimatedCardHeight),
            )
            val ttl = interactionTtlFor(interaction, fallbackMs = 7_000L)
            val card = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER
                setPadding(dp(38), dp(20), dp(38), dp(24))
                background = rainbowPraiseBackground()
                alpha = 0f
                scaleX = 0.88f
                scaleY = 0.88f
                translationY = dp(42).toFloat()
                rotation = ((seed % 9) - 4) * 0.35f
                elevation = dp(18).toFloat()
            }
            card.addView(TextView(this).apply {
                text = "彩虹屁"
                textSize = 18f
                typeface = Typeface.DEFAULT_BOLD
                setTextColor(Color.rgb(3, 18, 11))
                gravity = Gravity.CENTER
                includeFontPadding = false
                background = GradientDrawable(
                    GradientDrawable.Orientation.LEFT_RIGHT,
                    intArrayOf(
                        Color.rgb(251, 113, 133),
                        Color.rgb(250, 204, 21),
                        Color.rgb(52, 211, 153),
                        Color.rgb(34, 211, 238),
                    ),
                ).apply {
                    cornerRadius = dp(999).toFloat()
                    setStroke(dp(1), Color.argb(108, 248, 250, 252))
                }
                setPadding(dp(16), dp(8), dp(16), dp(8))
            })
            card.addView(TextView(this).apply {
                text = interaction.message
                textSize = 38f
                typeface = Typeface.DEFAULT_BOLD
                setTextColor(Color.rgb(248, 250, 252))
                gravity = Gravity.CENTER
                includeFontPadding = false
                maxLines = 2
                ellipsize = TextUtils.TruncateAt.END
                maxWidth = (layerWidth * 0.58f).toInt().coerceAtMost(dp(980))
                setShadowLayer(dp(4).toFloat(), 0f, dp(3).toFloat(), Color.argb(128, 0, 0, 0))
            }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                this.topMargin = dp(14)
            })

            interactionLayer.addView(
                card,
                FrameLayout.LayoutParams((layerWidth * 0.52f).toInt().coerceIn(dp(620), dp(980)), FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply {
                    this.topMargin = cardTopMargin
                },
            )
            rainbowPraiseCards[interaction.id] = card
            card.post {
                val originY = cardTopMargin + card.height / 2
                renderRainbowPraiseRibbons(originY, seed)
                renderRainbowPraiseSparks(layerWidth / 2, originY, seed)
                card.animate()
                    .alpha(1f)
                    .scaleX(1f)
                    .scaleY(1f)
                    .translationY(0f)
                    .setDuration(360L)
                    .setInterpolator(DecelerateInterpolator())
                    .start()
            }
            interactionHandler.postDelayed({
                card.animate()
                    .alpha(0f)
                    .translationYBy(-dp(18).toFloat())
                    .scaleX(0.98f)
                    .scaleY(0.98f)
                    .setDuration(320L)
                    .setInterpolator(DecelerateInterpolator())
                    .withEndAction {
                        if (rainbowPraiseCards[interaction.id] === card) {
                            rainbowPraiseCards.remove(interaction.id)
                        }
                        interactionLayer.removeView(card)
                    }
                    .start()
            }, (ttl - 320L).coerceAtLeast(1_000L))
        }
    }

    private fun currentRainbowPraiseBounds(fallbackHeight: Int): List<RainbowPraiseCardBounds> {
        return rainbowPraiseCards.values.mapNotNull { view ->
            val params = view.layoutParams as? FrameLayout.LayoutParams ?: return@mapNotNull null
            val height = view.height
                .takeIf { it > 0 }
                ?: view.measuredHeight.takeIf { it > 0 }
                ?: fallbackHeight
            RainbowPraiseCardBounds(top = params.topMargin, height = height)
        }
    }

    private fun renderRainbowPraiseRibbons(centerY: Int, seed: Int) {
        val colors = intArrayOf(
            Color.rgb(251, 113, 133),
            Color.rgb(250, 204, 21),
            Color.rgb(52, 211, 153),
            Color.rgb(34, 211, 238),
            Color.rgb(167, 139, 250),
        )
        repeat(5) { index ->
            val ribbon = View(this).apply {
                background = roundedBackground(colors[index % colors.size], dp(999).toFloat())
                alpha = 0f
                rotation = -8f + index * 4f
                translationX = -dp(420 + index * 16).toFloat()
            }
            interactionLayer.addView(
                ribbon,
                FrameLayout.LayoutParams(dp(520 + (seed + index * 31) % 180), dp(8 + index % 2 * 3), Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply {
                    topMargin = centerY - dp(70) + index * dp(22)
                },
            )
            ribbon.animate()
                .alpha(0.78f)
                .translationX(dp(420 + index * 20).toFloat())
                .setDuration((1_050 + index * 120).toLong())
                .setInterpolator(LinearInterpolator())
                .withEndAction { interactionLayer.removeView(ribbon) }
                .start()
        }
    }

    private fun renderRainbowPraiseSparks(originX: Int, originY: Int, seed: Int) {
        val colors = intArrayOf(
            Color.rgb(251, 113, 133),
            Color.rgb(250, 204, 21),
            Color.rgb(52, 211, 153),
            Color.rgb(34, 211, 238),
            Color.rgb(167, 139, 250),
            Color.rgb(248, 250, 252),
        )
        repeat(16) { index ->
            val spark = View(this).apply {
                background = roundedBackground(colors[index % colors.size], dp(999).toFloat())
                alpha = 0f
            }
            interactionLayer.addView(
                spark,
                FrameLayout.LayoutParams(dp(8 + index % 3 * 2), dp(8 + index % 3 * 2)).apply {
                    leftMargin = originX
                    topMargin = originY
                },
            )
            val direction = if (index % 2 == 0) 1 else -1
            val travelX = direction * dp(70 + (seed + index * 37) % 190).toFloat()
            val travelY = -dp(42 + (seed + index * 29) % 120).toFloat()
            spark.animate()
                .alpha(1f)
                .translationX(travelX)
                .translationY(travelY)
                .rotationBy(direction * 260f)
                .setStartDelay((index * 42).toLong())
                .setDuration((980 + index * 38).toLong())
                .setInterpolator(DecelerateInterpolator())
                .withEndAction { interactionLayer.removeView(spark) }
                .start()
        }
    }

    private fun renderBulletInteraction(interaction: RoomInteractionEvent) {
        interactionLayer.post {
            val layerWidth = interactionLayer.width.coerceAtLeast(dp(720))
            val layerHeight = interactionLayer.height.coerceAtLeast(dp(420))
            val ttl = interactionTtlFor(interaction, fallbackMs = 7_000L)
            val accentColor = bulletAccentColor(interaction.id)
            val banner = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(22), dp(14), dp(28), dp(14))
                background = panelBackground(
                    color = Color.argb(190, 15, 23, 42),
                    radius = dp(999).toFloat(),
                    strokeColor = accentColor.argb(86),
                )
                elevation = dp(12).toFloat()
                translationX = layerWidth + dp(48).toFloat()
                alpha = 0f
                visibility = View.INVISIBLE
            }
            banner.addView(
                View(this).apply {
                    background = roundedBackground(accentColor.rgb(), dp(999).toFloat())
                },
                LinearLayout.LayoutParams(dp(7), dp(34)),
            )
            banner.addView(
                TextView(this).apply {
                    text = interaction.message
                    textSize = 32f
                    typeface = Typeface.DEFAULT_BOLD
                    setTextColor(Color.rgb(248, 250, 252))
                    includeFontPadding = false
                    maxWidth = (layerWidth * 0.58f).toInt().coerceAtMost(dp(880))
                    ellipsize = TextUtils.TruncateAt.END
                    setSingleLine(true)
                },
                LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                    leftMargin = dp(18)
                },
            )
            interactionLayer.addView(
                banner,
                FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT).apply {
                    leftMargin = 0
                    topMargin = dp(92)
                },
            )
            banner.post {
                val plan = bulletMarqueePlan(
                    id = interaction.id,
                    layerWidth = layerWidth,
                    layerHeight = layerHeight,
                    bannerWidth = banner.width,
                    bannerHeight = banner.height,
                    horizontalGutter = dp(56),
                    minTop = dp(84),
                    bottomReserved = dp(150),
                )
                val params = banner.layoutParams as? FrameLayout.LayoutParams
                if (params != null) {
                    params.topMargin = plan.top
                    banner.layoutParams = params
                }
                banner.translationX = plan.startTranslationX
                banner.visibility = View.VISIBLE
                banner.alpha = 1f
                banner.animate()
                    .translationX(plan.endTranslationX)
                    .alpha(0.98f)
                    .setDuration(ttl)
                    .setInterpolator(LinearInterpolator())
                    .withEndAction { interactionLayer.removeView(banner) }
                    .start()
            }
        }
    }

    private fun renderBlessingInteraction(interaction: RoomInteractionEvent) {
        interactionLayer.post {
            blessingInteractions.remove(interaction.id)?.second?.let { interactionLayer.removeView(it) }
            val card = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER
                setPadding(dp(28), dp(12), dp(28), dp(14))
                background = panelBackground(
                    color = Color.argb(224, 15, 23, 42),
                    radius = dp(18).toFloat(),
                    strokeColor = Color.argb(138, 244, 114, 182),
                )
                alpha = 0f
                translationY = -dp(18).toFloat()
                elevation = dp(16).toFloat()
            }
            card.addView(TextView(this).apply {
                text = "祝福"
                textSize = 16f
                typeface = Typeface.DEFAULT_BOLD
                setTextColor(Color.rgb(251, 191, 36))
                includeFontPadding = false
            })
            card.addView(TextView(this).apply {
                text = interaction.message
                textSize = 32f
                typeface = Typeface.DEFAULT_BOLD
                setTextColor(Color.rgb(248, 250, 252))
                gravity = Gravity.CENTER
                includeFontPadding = false
                maxLines = 2
                ellipsize = TextUtils.TruncateAt.END
            })

            interactionLayer.addView(
                card,
                FrameLayout.LayoutParams(dp(620), FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.CENTER_HORIZONTAL),
            )
            blessingInteractions[interaction.id] = interaction to card
            layoutBlessingStack()
            card.post { layoutBlessingStack() }
            card.animate()
                .alpha(1f)
                .translationY(0f)
                .setDuration(220L)
                .setInterpolator(DecelerateInterpolator())
                .start()
            val scheduledView = card
            interactionHandler.postDelayed({
                if (blessingInteractions[interaction.id]?.second === scheduledView) {
                    removeBlessingInteraction(interaction.id)
                }
            }, interactionTtlFor(interaction, fallbackMs = 7_000L))
        }
    }

    private fun layoutBlessingStack() {
        val sorted = sortBlessingsNewestFirst(blessingInteractions.values.map { it.first })
        val measuredHeights = sorted.map { interaction ->
            val view = blessingInteractions[interaction.id]?.second
            (view?.height ?: 0).takeIf { it > 0 }
                ?: (view?.measuredHeight ?: 0).takeIf { it > 0 }
                ?: dp(92)
        }
        val topMargins = blessingStackTopMargins(
            cardHeights = measuredHeights,
            firstTop = dp(52),
            gap = dp(14),
            minCardHeight = dp(84),
        )
        sorted.forEachIndexed { index, interaction ->
            val view = blessingInteractions[interaction.id]?.second ?: return@forEachIndexed
            val params = view.layoutParams as? FrameLayout.LayoutParams ?: return@forEachIndexed
            params.gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
            params.topMargin = topMargins.getOrElse(index) { dp(52) }
            view.layoutParams = params
        }
    }

    private fun removeBlessingInteraction(id: String) {
        val view = blessingInteractions.remove(id)?.second ?: return
        view.animate()
            .alpha(0f)
            .translationYBy(-dp(10).toFloat())
            .setDuration(180L)
            .withEndAction {
                interactionLayer.removeView(view)
                layoutBlessingStack()
            }
            .start()
    }

    private fun fadeOutAndRemoveViewLater(view: View, delayMs: Long) {
        interactionHandler.postDelayed({
            view.animate()
                .alpha(0f)
                .scaleX(0.82f)
                .scaleY(0.82f)
                .setDuration(420L)
                .setInterpolator(DecelerateInterpolator())
                .withEndAction { (view.parent as? FrameLayout)?.removeView(view) }
                .start()
        }, (delayMs - 420L).coerceAtLeast(1_000L))
    }

    private fun clearRoomInteractions() {
        blessingInteractions.clear()
        rainbowPraiseCards.clear()
        interactionHandler.removeCallbacksAndMessages(null)
        if (::interactionLayer.isInitialized) {
            interactionLayer.removeAllViews()
            installEmojiPhysicsLayer()
        }
    }

    private fun interactionTtlFor(interaction: RoomInteractionEvent, fallbackMs: Long): Long {
        return interactionTtlMs(interaction, fallbackMs)
            .coerceAtLeast(1_000L)
            .coerceAtMost(15_000L)
    }

    private fun shouldClearStatusNotice(value: String): Boolean {
        return value == "电视在线，等待点歌" ||
            value == "已停止" ||
            value == "已暂停" ||
            value == "正在播放" ||
            value.startsWith("正在播放 ·")
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
        return "${target.sourceType}:${target.assetId}:${target.queueEntryId}:${target.vocalMode}:$index:$id"
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

    private fun playbackStateLabel(): String {
        return playbackStateLabelForMedia(
            roomModeActive = roomModeActive,
            hasActiveTarget = activeTarget != null,
            hasCurrentMedia = currentMediaUrl != null,
            isPlayerPlaying = ::mediaPlayer.isInitialized && mediaPlayer.isPlaying,
        )
    }

    private fun vocalModeColor(vocalMode: String?): Int {
        return when (vocalMode) {
            "original" -> Color.rgb(52, 211, 153)
            "instrumental" -> Color.rgb(34, 211, 238)
            else -> Color.rgb(248, 250, 252)
        }
    }

    private fun playbackStateColor(label: String): Int {
        return when (label) {
            "播放中" -> Color.rgb(52, 211, 153)
            "准备中" -> Color.rgb(251, 191, 36)
            "异常" -> Color.rgb(248, 113, 113)
            else -> Color.rgb(203, 213, 225)
        }
    }

    private fun toneColor(tone: TvStatusTone): Int {
        return when (tone) {
            TvStatusTone.READY -> Color.rgb(52, 211, 153)
            TvStatusTone.WARNING -> Color.rgb(251, 191, 36)
            TvStatusTone.DANGER -> Color.rgb(248, 113, 113)
            TvStatusTone.NEUTRAL -> Color.rgb(203, 213, 225)
        }
    }

    private fun toneSurfaceColor(tone: TvStatusTone): Int {
        return when (tone) {
            TvStatusTone.READY -> Color.argb(42, 52, 211, 153)
            TvStatusTone.WARNING -> Color.argb(42, 251, 191, 36)
            TvStatusTone.DANGER -> Color.argb(46, 248, 113, 113)
            TvStatusTone.NEUTRAL -> Color.argb(42, 148, 163, 184)
        }
    }

    private fun idleStatusDotColor(label: String): Int {
        return when {
            label.contains("冲突") || label.contains("异常") -> Color.rgb(248, 113, 113)
            label.contains("注册") || label.contains("同步") -> Color.rgb(251, 191, 36)
            else -> Color.rgb(52, 211, 153)
        }
    }

    private fun statusPillBackground(tone: TvStatusTone): GradientDrawable {
        return panelBackground(
            color = toneSurfaceColor(tone),
            radius = dp(999).toFloat(),
            strokeColor = toneColor(tone),
        )
    }

    private fun panelBackground(color: Int, radius: Float, strokeColor: Int): GradientDrawable {
        return GradientDrawable().apply {
            setColor(color)
            cornerRadius = radius
            setStroke(dp(1), strokeColor)
        }
    }

    private fun rainbowPraiseBackground(): GradientDrawable {
        return GradientDrawable(
            GradientDrawable.Orientation.LEFT_RIGHT,
            intArrayOf(
                Color.argb(224, 251, 113, 133),
                Color.argb(218, 250, 204, 21),
                Color.argb(218, 34, 211, 238),
                Color.argb(224, 52, 211, 153),
            ),
        ).apply {
            cornerRadius = dp(26).toFloat()
            setStroke(dp(1), Color.argb(122, 248, 250, 252))
        }
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
        private const val MEDIA_REPLACEMENT_SUPPRESSION_MS = 1_200L
        private const val PLAYBACK_ERROR_RECOVERY_RETRIES = 1
        private const val PLAYBACK_ERROR_RECOVERY_REWIND_MS = 1_500L
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
