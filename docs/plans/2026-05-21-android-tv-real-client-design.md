# Android TV Real Client Design

## Goal

Build the existing `HomeKTV` Android project into the primary TV player for real KTV use. The app uses libVLC for broad local media compatibility and reuses the current Web TV player protocol.

## Runtime Shape

The app has two modes:

- Room mode, the default when no `mediaUrl` is supplied. It registers the TV, listens for room snapshots, plays the current target, reports heartbeat and telemetry, and commits vocal switches through the existing backend flow.
- Sample mode, kept as a diagnostic path when `mediaUrl` is provided or when the sample sweep button is used.

Room mode talks to:

- `POST /player/bootstrap`
- `GET /rooms/:roomSlug/snapshot`
- `GET /rooms/:roomSlug/realtime?deviceId=...&client=tv`
- `POST /player/heartbeat`
- `POST /player/telemetry`
- `POST /player/switch-transition`
- `POST /player/reconnect-recovery`

## Playback

libVLC is the only playback engine. A new `PlaybackTarget` starts playback from `playbackUrl` at `resumePositionMs`. If the target has `selectedTrackRef`, the app selects the matching VLC audio track after libVLC exposes track metadata. Matching prefers the track index because ffprobe IDs and VLC ES IDs are not guaranteed to be identical.

Vocal switching follows the current server contract:

1. Detect `targetVocalMode != currentTarget.vocalMode`.
2. Request `/player/switch-transition` with the current position.
3. For `audio_track`, switch the VLC audio track in-place.
4. Report `playing` with `stage=switch_committed` on success.
5. Report `switch_failed` and keep the current playback on failure.

## UI

The first screen is the usable TV player, not a setup page. It shows connection state, current song, artist, current mode, next song, progress, audio track status, and current media URL for debugging. In sample mode it keeps the sample sweep controls.

## Testing

Pure Kotlin unit tests cover launch config parsing, snapshot parsing, realtime envelope parsing, playback decisions, audio track selection, and telemetry payload creation. Device testing verifies end-to-end playback, queue advance, heartbeat presence, and vocal switching on real NAS media.
