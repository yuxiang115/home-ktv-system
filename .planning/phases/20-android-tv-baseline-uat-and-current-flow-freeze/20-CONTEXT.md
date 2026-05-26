# Phase 20: Android TV Baseline UAT and Current Flow Freeze - Context

**Gathered:** 2026-05-26
**Status:** Ready for execution

<domain>
## Phase Boundary

Phase 20 does not add new runtime capability. It freezes the current real Android TV playback flow as the regression baseline for v1.4. The output is a clear UAT checklist, verification command set, current-flow notes, and known limitation register.

This phase exists because recent work moved the product from Web TV debugging to Android TV + libVLC real playback. Before changing startup configuration, APK release, diagnostics, or simplifying old flows, the project needs one stable answer to: "what must still work after every change?"

</domain>

<decisions>
## Implementation Decisions

- Android TV is the official TV playback target for real usage.
- Web TV remains useful as a local/debug client, but browser autoplay and browser audio-track limitations are not product blockers for the official TV path.
- UAT must be executable by the user without asking what to verify next.
- The baseline must cover the real chain: API/Admin/Mobile/Android TV/PostgreSQL/NAS.
- Volume is one room-level playback volume.
- Original/accompaniment switching is audio-track switching inside the current single media file.
- If a media file has only one audio track, switch failure is not automatically a product bug; the UAT should use a known dual-track song for switch validation.
- Phase 20 should not delete legacy flows. Simplification happens in Phase 24 after an evidence audit.

</decisions>

<canonical_refs>
## Canonical References

- `.planning/PROJECT.md` - v1.4 current milestone and Android TV direction.
- `.planning/ROADMAP.md` - Phase 20 scope and success criteria.
- `.planning/REQUIREMENTS.md` - BASE-01, BASE-02, BASE-03.
- `docs/deployment.md` - user-facing deployment and baseline verification steps.
- `HomeKTV/README.md` - Android TV build/install/playback notes.
- `docs/plans/2026-05-26-android-tv-productization-simplification-design.md` - accepted productization sequence.
- `docs/plans/2026-05-26-android-tv-productization-simplification.md` - high-level implementation plan.

</canonical_refs>

<code_context>
## Current Runtime Baseline

- API serves health, room snapshots, queue commands, media/asset streams, player bootstrap, telemetry, and control snapshots.
- Mobile controller is the only user control surface for search, queue, skip, original/accompaniment, and volume.
- Admin can observe room/TV state and real song/source diagnostics.
- Android TV registers as TV player, shows QR while idle, plays the current queue item, applies volume, switches libVLC audio tracks, and reports playback facts.
- Real songs are found via `ktv_*` index search and synced into canonical `songs/assets` at queue time.

</code_context>

<specifics>
## Baseline UAT Must Cover

1. Services start with LAN-accessible `PUBLIC_BASE_URL` and controller URL.
2. Android TV APK installs and launches against the LAN API.
3. Idle TV page shows QR.
4. Mobile controller opens from QR/controller URL and shows TV online.
5. Searching a real song returns queueable results.
6. Queueing starts playback on Android TV.
7. Skip/promote/delete update Mobile/Admin/TV without page refresh.
8. Original/accompaniment switch changes displayed mode/track on a known dual-track song.
9. Volume slider affects Android TV playback and survives song changes.
10. Closing and reopening Mobile controller restores current room state.

</specifics>

<deferred>
## Deferred Ideas

- Persist Android TV config and no-parameter launch: Phase 21.
- Release signing, install/update/rollback workflow: Phase 22.
- Failure-state hardening and diagnostics: Phase 23.
- Code and flow simplification: Phase 24.
- Admin real library operations: Phase 25.
- Real-mode smoke command and milestone audit: Phase 26.

</deferred>

---

*Phase: 20-android-tv-baseline-uat-and-current-flow-freeze*
*Context gathered: 2026-05-26*
