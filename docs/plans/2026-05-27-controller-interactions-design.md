# Controller Interactions Design

## Goal

Wire the mobile controller shortcut UI into real behavior for `发表情`, `发弹幕`, and `送祝福`, and make the web TV preview render those interactions immediately through the existing realtime channel.

## Scope

This design targets the web controller and `tv-web` only. Android UI remains untouched.

The discovery logic already has search, recommendations, artist modules, genre modules, and weighted random selection. For ambiguous singer/style classification, this pass will avoid risky inference. It will normalize obvious empty/duplicate genre labels only. Deeper metadata enrichment can wait for a follow-up decision.

## Architecture

Use a lightweight realtime interaction event instead of storing these actions in the playback session. The controller posts an authenticated interaction to the API. The API validates the active control session, builds a bounded event payload, and broadcasts it to all room realtime subscribers through the existing `RoomSnapshotBroadcaster`.

TV web listens to the same WebSocket used for room snapshots. Snapshot messages continue updating playback state; interaction messages update a short-lived local overlay queue.

## Event Model

Add shared contracts:

- `RoomInteractionKind`: `emoji | bullet | blessing`
- `RoomInteractionEvent`: event id, room id, room slug, kind, message, sender device id, sender name, created/expires timestamps
- Realtime type: `room.interaction.created`

Payload rules:

- `emoji`: message is one short emoji/symbol string, max 8 visible characters
- `bullet`: text message, max 60 visible characters
- `blessing`: text message, max 80 visible characters
- All messages are trimmed, whitespace-collapsed, and rejected if empty

## Controller UX

The three shortcut buttons become real actions:

- `发表情`: opens a compact picker with preset reactions. Tapping one sends immediately.
- `发弹幕`: opens a text composer with send/cancel.
- `送祝福`: opens template chips plus a text composer.

On success, the panel stays open so users can send repeatedly. Emoji supports repeated taps and long-press burst sending. While submitting, buttons are disabled. On API error, the existing error banner shows the failure.

## TV Web UX

`tv-web` renders overlays on top of idle and playback screens:

- Emoji: Matter.js cannon launch from the lower screen with bounce and confetti.
- Bullet comment: CSS marquee from a stable random right-side lane to the left edge, about seven seconds.
- Blessing: newest-first top stack; later blessings appear above and push older blessings down.

Events expire locally based on the API `expiresAt`. The runtime keeps active events until their own expiry instead of applying a low fixed count cap.

## Discovery / Classification

This pass will not attempt full singer/style inference from filenames or external catalogs. It will only keep the existing metadata-driven modules and normalize empty genre labels to `其他`.

Follow-up open-source options when we decide to solve this properly:

- MusicBrainz / AcoustID for metadata enrichment.
- Essentia or other audio-feature tooling for genre inference, if metadata is missing.
- A curated KTV filename parser if the library source naming conventions are stable.

## Verification

- API route tests for validation, auth, and realtime broadcast.
- Controller tests for opening panels and sending payloads.
- TV web tests for receiving `room.interaction.created` and rendering overlay content.
- Build/typecheck/test for `@home-ktv/api`, `@home-ktv/controller`, `@home-ktv/tv-web`, and affected packages.
