# Phase 19: Search and Queue-Time Catalog Sync - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-20
**Phase:** 19-Search and Queue-Time Catalog Sync
**Areas discussed:** Mobile indexed queue entry, idempotent catalog identity, failure and unavailable states, queue command contract

---

## Mobile Indexed Queue Entry

| Option | Description | Selected |
|--------|-------------|----------|
| `点歌` | User does not need to understand catalog sync; API handles it behind the command. | ✓ |
| `同步并点歌` | More transparent but exposes internal mechanics to normal users. | |
| `同步入库` then queue | Safer but adds an extra user step. | |

**User's choice:** `点歌`
**Notes:** Mobile should hide sync mechanics and make indexed results feel directly queueable.

| Option | Description | Selected |
|--------|-------------|----------|
| Inline `正在加入...` | Disable only the clicked version button while the command is running. | ✓ |
| Global banner | Show `正在同步入库并加入队列` at the top. | |
| Modal/progress dialog | Use a blocking confirmation/progress UI. | |

**User's choice:** Inline `正在加入...`
**Notes:** Keep the interaction lightweight.

| Option | Description | Selected |
|--------|-------------|----------|
| Refresh into local catalog section | Immediately refresh search and snapshot; result appears as local and queued. | |
| Keep in KTV index section as queued | Preserve indexed result placement but update the button/state to `已点`. | ✓ |
| Do not refresh search | Let the queue alone prove success. | |

**User's choice:** Keep in KTV index section as queued.
**Notes:** The user wants immediate state feedback without moving the visible result out from under them.

| Option | Description | Selected |
|--------|-------------|----------|
| Expanded version rows | Each indexed version has its own `点歌` button. | ✓ |
| Recommended version only | Show one default and fold other versions away. | |
| Modal version picker | Click song first, then choose a version. | |

**User's choice:** Expanded version rows.
**Notes:** Preserve the current Phase 18 grouped/expanded indexed result structure.

---

## Idempotent Catalog Identity

| Option | Description | Selected |
|--------|-------------|----------|
| `ktv_song_assets.id` identity | Same indexed asset always reuses the same canonical Asset. | ✓ |
| `file_path` identity | Use path as unique identity. | |
| New Asset each time | Every queue creates another canonical Asset. | |

**User's choice:** `ktv_song_assets.id` identity.
**Notes:** Stable source row identity is the durable sync key.

| Option | Description | Selected |
|--------|-------------|----------|
| `ktv_songs.id` maps to one canonical Song | Multiple indexed assets become versions/assets of the same canonical Song. | ✓ |
| Asset creates independent Song | Each indexed asset creates a separate canonical Song. | |
| Merge by title and artist | Coalesce by display metadata. | |

**User's choice:** `ktv_songs.id` maps to one canonical Song.
**Notes:** Avoid accidental metadata-based merges while preserving version grouping.

| Option | Description | Selected |
|--------|-------------|----------|
| Light update from latest `ktv_*` | Refresh canonical metadata where appropriate, preserving queue stability. | ✓ |
| Freeze after first sync | Do not update canonical metadata automatically after first sync. | |
| New canonical record on change | Treat metadata changes as new records. | |

**User's choice:** Light update from latest `ktv_*`.
**Notes:** Canonical records should stay aligned with the index without disrupting existing queue entries.

| Option | Description | Selected |
|--------|-------------|----------|
| Searchable and queueable immediately | Media playability proof is deferred to Phase 20. | ✓ |
| `review_required` first | Mobile cannot queue until Admin confirms. | |
| Hidden record | Queue can use it but search does not show it. | |

**User's choice:** Searchable and queueable immediately.
**Notes:** Phase 19 should make the real indexed library practically usable; media proof is a later boundary.

---

## Failure And Unavailable States

| Option | Description | Selected |
|--------|-------------|----------|
| Keep visible and disabled | Show `索引已失效` when source row is gone or missing. | ✓ |
| Hide from results | Remove invalid rows from Mobile search. | |
| Error only after click | Let users click and then see an error. | |

**User's choice:** Keep visible and disabled.
**Notes:** Preserve visible evidence and avoid confusing disappearance.

| Option | Description | Selected |
|--------|-------------|----------|
| Do not block Phase 19 | Sync and queue do not require NAS readability; Phase 20 owns path/playback proof. | |
| Block point-song | Show `文件不可读` before queueing. | ✓ |
| Light stat before queue | Allow queue only when a quick read check passes. | |

**User's choice:** Block point-song for unreadable/unmapped paths.
**Notes:** If unreadable/unmapped path evidence is already known for the selected indexed asset, block queueing with `文件不可读`. This should not expand into full Phase 20 streaming or browser playback verification.

| Option | Description | Selected |
|--------|-------------|----------|
| Roll back sync and queue | Clear Chinese error, queue unchanged. | ✓ |
| Keep partial canonical rows | Tell the user to retry later. | |
| Silent retries then generic error | Hide detailed failure cause from Mobile. | |

**User's choice:** Roll back sync and queue.
**Notes:** Atomicity matters; partial sync should not leak into queue state.

| Option | Description | Selected |
|--------|-------------|----------|
| Admin source inspection | Show `ktv_songs.id`, `ktv_song_assets.id`, and `file_path` in Songs/diagnostics. | ✓ |
| No Admin surface | Phase 19 only makes Mobile queueing work. | |
| Logs only | Source traceability is not exposed through API/UI. | |

**User's choice:** Admin source inspection.
**Notes:** Operators need traceability from canonical rows back to indexed source.

---

## Queue Command Contract

| Option | Description | Selected |
|--------|-------------|----------|
| Extend `add-queue-entry` | Accept indexed source, sync server-side, then queue canonical IDs. | ✓ |
| New `add-indexed-queue-entry` command | Separate command path for indexed songs. | |
| Client calls sync then queue | Mobile orchestrates two requests. | |

**User's choice:** Extend `add-queue-entry`.
**Notes:** Reuse the existing session/version/command/snapshot envelope.

| Option | Description | Selected |
|--------|-------------|----------|
| Canonical IDs or `indexedAssetId` | Payload accepts either `songId/assetId` or `indexedAssetId`, not both. | ✓ |
| `indexedSongId + indexedAssetId` | Require both indexed IDs. | |
| Full indexed metadata | Mobile sends song/version metadata to avoid another server query. | |

**User's choice:** Canonical IDs or `indexedAssetId`.
**Notes:** Mobile must not send NAS paths or source metadata; server resolves source rows.

| Option | Description | Selected |
|--------|-------------|----------|
| Existing duplicate confirmation after sync | Canonical Song queue-state drives duplicate confirmation. | ✓ |
| Always allow duplicate | Indexed results bypass duplicate confirmation. | |
| Disable same indexed asset | Prevent repeats when the exact asset is queued. | |

**User's choice:** Existing duplicate confirmation after sync.
**Notes:** Preserve current Mobile behavior for repeated songs.

| Option | Description | Selected |
|--------|-------------|----------|
| API + realtime + Mobile tests | Cover catalog sync, queue/snapshot behavior, and indexed UI state. | ✓ |
| API only | Leave UI to manual UAT. | |
| Sync service only | Existing queue tests are enough. | |

**User's choice:** API + realtime + Mobile tests.
**Notes:** Phase 19 changes cross the API/UI boundary and need regression coverage there.

---

## the agent's Discretion

- Exact source identity storage and ID naming are left to planning/implementation, provided identity is durable and idempotent.
- Exact Admin placement for source inspection can reuse Songs/KTV diagnostics patterns.

## Deferred Ideas

- NAS path mapping, streaming, playback target verification, and browser playback support remain Phase 20.
- Deployment profile and real-mode health commands remain Phase 21.
- Native Android TV and preprocessing automation remain future requirements.
