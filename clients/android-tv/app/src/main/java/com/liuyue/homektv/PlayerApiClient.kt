package com.liuyue.homektv

import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.io.IOException

class PlayerApiClient(
    apiBaseUrl: String,
    private val httpClient: OkHttpClient = OkHttpClient(),
) {
    private val apiBaseUrl = apiBaseUrl.trimEnd('/')
    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    fun bootstrap(
        roomSlug: String,
        deviceId: String,
        deviceName: String,
        callback: ResultCallback<BootstrapResult>,
    ) {
        postJson(
            path = "/player/bootstrap",
            body = PlayerApiPayloads.bootstrap(roomSlug, deviceId, deviceName),
            parser = { PlayerContractsJson.bootstrapFromJson(it) },
            callback = callback,
        )
    }

    fun fetchSnapshot(
        roomSlug: String,
        callback: ResultCallback<RoomSnapshot>,
    ) {
        val request = Request.Builder()
            .url("$apiBaseUrl/rooms/${roomSlug.urlSegment()}/snapshot")
            .header("Accept", "application/json")
            .get()
            .build()
        httpClient.newCall(request).enqueue(jsonCallback(PlayerContractsJson::roomSnapshotFromJson, callback))
    }

    fun sendHeartbeat(
        roomSlug: String,
        deviceId: String,
        currentQueueEntryId: String?,
        playbackPositionMs: Long,
        health: String,
        callback: ResultCallback<Unit> = ResultCallback.ignore(),
    ) {
        postJson(
            path = "/player/heartbeat",
            body = PlayerApiPayloads.heartbeat(roomSlug, deviceId, currentQueueEntryId, playbackPositionMs, health),
            parser = { Unit },
            callback = callback,
        )
    }

    fun sendTelemetry(
        roomSlug: String,
        deviceId: String,
        eventType: String,
        sessionVersion: Int,
        queueEntryId: String,
        assetId: String,
        playbackPositionMs: Long,
        vocalMode: String,
        switchFamily: String?,
        rollbackAssetId: String?,
        stage: String?,
        message: String? = null,
        errorCode: String? = null,
        callback: ResultCallback<Unit> = ResultCallback.ignore(),
    ) {
        postJson(
            path = "/player/telemetry",
            body = PlayerApiPayloads.telemetry(
                roomSlug = roomSlug,
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
            ),
            parser = { Unit },
            callback = callback,
        )
    }

    fun requestSwitchTransition(
        roomSlug: String,
        playbackPositionMs: Long,
        callback: ResultCallback<SwitchTransitionResult>,
    ) {
        postJson(
            path = "/player/switch-transition",
            body = PlayerApiPayloads.switchTransition(roomSlug, playbackPositionMs),
            parser = { PlayerContractsJson.switchTransitionFromJson(it) },
            callback = callback,
        )
    }

    fun requestReconnectRecovery(
        roomSlug: String,
        deviceId: String,
        callback: ResultCallback<ReconnectRecoveryResult>,
    ) {
        postJson(
            path = "/player/reconnect-recovery",
            body = PlayerApiPayloads.reconnectRecovery(roomSlug, deviceId),
            parser = { PlayerContractsJson.reconnectRecoveryFromJson(it) },
            callback = callback,
        )
    }

    fun openRealtime(
        roomSlug: String,
        deviceId: String,
        listener: RoomRealtimeListener,
    ): WebSocket {
        val request = Request.Builder()
            .url(realtimeSocketUrl(roomSlug, deviceId))
            .build()
        return httpClient.newWebSocket(
            request,
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    listener.onOpen()
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    val snapshot = PlayerContractsJson.roomSnapshotFromRealtimeMessage(text)
                    if (snapshot != null) {
                        listener.onSnapshot(snapshot)
                    }
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    listener.onClosed(reason)
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    listener.onError(t)
                }
            },
        )
    }

    private fun <T> postJson(
        path: String,
        body: JSONObject,
        parser: (JSONObject) -> T,
        callback: ResultCallback<T>,
    ) {
        val request = Request.Builder()
            .url("$apiBaseUrl$path")
            .header("Accept", "application/json")
            .post(body.toString().toRequestBody(jsonMediaType))
            .build()
        httpClient.newCall(request).enqueue(jsonCallback(parser, callback))
    }

    private fun <T> jsonCallback(
        parser: (JSONObject) -> T,
        callback: ResultCallback<T>,
    ): Callback {
        return object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                callback.onError(e)
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    val body = it.body?.string().orEmpty()
                    if (!it.isSuccessful) {
                        callback.onError(IOException("HTTP ${it.code}: $body"))
                        return
                    }

                    runCatching {
                        parser(if (body.isBlank()) JSONObject() else JSONObject(body))
                    }.onSuccess(callback::onSuccess)
                        .onFailure(callback::onError)
                }
            }
        }
    }

    private fun realtimeSocketUrl(roomSlug: String, deviceId: String): String {
        val socketBase = apiBaseUrl
            .replace(Regex("^http:"), "ws:")
            .replace(Regex("^https:"), "wss:")
        return "$socketBase/rooms/${roomSlug.urlSegment()}/realtime?deviceId=${deviceId.urlQuery()}&client=tv"
    }
}

fun interface ResultCallback<T> {
    fun onSuccess(value: T)

    fun onError(error: Throwable) = Unit

    companion object {
        fun <T> ignore(): ResultCallback<T> {
            return object : ResultCallback<T> {
                override fun onSuccess(value: T) = Unit
                override fun onError(error: Throwable) = Unit
            }
        }
    }
}

interface RoomRealtimeListener {
    fun onOpen()
    fun onSnapshot(snapshot: RoomSnapshot)
    fun onClosed(reason: String)
    fun onError(error: Throwable)
}

private fun String.urlSegment(): String {
    return java.net.URLEncoder.encode(this, Charsets.UTF_8.name()).replace("+", "%20")
}

private fun String.urlQuery(): String {
    return java.net.URLEncoder.encode(this, Charsets.UTF_8.name())
}
