package com.liuyue.homektv

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class PlayerContractsJsonTest {
    @Test
    fun parsesRoomSnapshotPlaybackTarget() {
        val snapshot = PlayerContractsJson.roomSnapshotFromJson(JSONObject(roomSnapshotJson(type = "room.snapshot")))

        assertEquals("living-room", snapshot.roomSlug)
        assertEquals(7, snapshot.sessionVersion)
        assertEquals("playing", snapshot.state)
        assertEquals(72, snapshot.volumePercent)
        assertEquals("instrumental", snapshot.targetVocalMode)
        assertEquals("http://192.168.5.64:5176/controller?room=living-room", snapshot.pairing?.qrPayload)

        val target = snapshot.currentTarget ?: error("expected current target")
        assertEquals("queue-1", target.queueEntryId)
        assertEquals("nas", target.sourceType)
        assertEquals("ktv-song-1", target.songId)
        assertEquals("asset-1", target.assetId)
        assertEquals("http://192.168.5.64:4000/media/nas/asset-1", target.playbackUrl)
        assertEquals(12_345L, target.resumePositionMs)
        assertEquals("稻香", target.currentQueueEntryPreview.songTitle)
        assertEquals("周杰伦", target.currentQueueEntryPreview.artistName)
        assertEquals("instrumental", target.vocalMode)
        assertEquals("single_file_audio_tracks", target.playbackProfile?.kind)
        assertEquals(true, target.playbackProfile?.requiresAudioTrackSelection)
        assertEquals(1, target.selectedTrackRef?.index)
        assertEquals("0x1101", target.selectedTrackRef?.id)
        assertEquals("伴奏", target.selectedTrackRef?.label)
        assertEquals("下一首", target.nextQueueEntryPreview?.songTitle)
    }

    @Test
    fun defaultsMissingRoomSnapshotVolumeTo50() {
        val json = JSONObject(roomSnapshotJson(type = "room.snapshot")).apply {
            remove("volumePercent")
        }

        val snapshot = PlayerContractsJson.roomSnapshotFromJson(json)

        assertEquals(50, snapshot.volumePercent)
    }

    @Test
    fun parsesRealtimeControlSnapshotEnvelope() {
        val message = """
            {
              "type": "room.control.snapshot.updated",
              "roomId": "room-1",
              "version": 7,
              "timestamp": "2026-05-21T00:00:00.000Z",
              "payload": ${roomSnapshotJson(type = "room.control.snapshot")}
            }
        """.trimIndent()

        val snapshot = PlayerContractsJson.roomSnapshotFromRealtimeMessage(message)

        assertNotNull(snapshot)
        assertEquals("living-room", snapshot?.roomSlug)
        assertEquals("asset-1", snapshot?.currentTarget?.assetId)
    }

    @Test
    fun parsesSwitchTransitionTargetSourceType() {
        val result = PlayerContractsJson.switchTransitionFromJson(
            JSONObject(
                """
                    {
                      "status": "ready",
                      "reason": null,
                      "switchTarget": {
                        "roomId": "room-1",
                        "sessionVersion": 7,
                        "queueEntryId": "queue-1",
                        "switchKind": "audio_track",
                        "sourceType": "nas",
                        "fromAssetId": "asset-1",
                        "toAssetId": "asset-1",
                        "playbackUrl": "http://192.168.5.64:4000/media/nas/asset-1",
                        "switchFamily": "real-mv-audio-track",
                        "vocalMode": "original",
                        "resumePositionMs": 12345,
                        "rollbackAssetId": "asset-1"
                      }
                    }
                """.trimIndent(),
            ),
        )

        assertEquals("ready", result.status)
        assertEquals("nas", result.switchTarget?.sourceType)
        assertEquals("asset-1", result.switchTarget?.toAssetId)
    }

    @Test
    fun ignoresRealtimePingMessages() {
        val snapshot = PlayerContractsJson.roomSnapshotFromRealtimeMessage(
            """{"type":"ping","timestamp":"2026-05-21T00:00:00.000Z"}""",
        )

        assertNull(snapshot)
    }

    private fun roomSnapshotJson(type: String): String {
        return """
            {
              "type": "$type",
              "roomId": "room-1",
              "roomSlug": "living-room",
              "sessionVersion": 7,
              "state": "playing",
              "volumePercent": 72,
              "pairing": {
                "roomSlug": "living-room",
                "controllerUrl": "http://192.168.5.64:5176/controller?room=living-room",
                "qrPayload": "http://192.168.5.64:5176/controller?room=living-room",
                "token": "token-1",
                "tokenExpiresAt": "2026-05-22T00:00:00.000Z"
              },
              "currentTarget": {
                "roomId": "room-1",
                "sessionVersion": 7,
                "queueEntryId": "queue-1",
                "sourceType": "nas",
                "songId": "ktv-song-1",
                "assetId": "asset-1",
                "currentQueueEntryPreview": {
                  "queueEntryId": "queue-1",
                  "songTitle": "稻香",
                  "artistName": "周杰伦"
                },
                "playbackUrl": "http://192.168.5.64:4000/media/nas/asset-1",
                "resumePositionMs": 12345,
                "vocalMode": "instrumental",
                "switchFamily": "real-mv-audio-track",
                "playbackProfile": {
                  "kind": "single_file_audio_tracks",
                  "container": "matroska,webm",
                  "videoCodec": "rv40",
                  "audioCodecs": ["aac", "aac"],
                  "requiresAudioTrackSelection": true
                },
                "selectedTrackRef": {
                  "index": 1,
                  "id": "0x1101",
                  "label": "伴奏"
                },
                "nextQueueEntryPreview": {
                  "queueEntryId": "queue-2",
                  "songTitle": "下一首",
                  "artistName": "歌手"
                }
              },
              "switchTarget": null,
              "targetVocalMode": "instrumental",
              "conflict": null,
              "notice": null,
              "generatedAt": "2026-05-21T00:00:00.000Z"
            }
        """.trimIndent()
    }
}
