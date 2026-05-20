# Phase 19: Search and Queue-Time Catalog Sync - Context

**Gathered:** 2026-05-20
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 19 makes KTV indexed search results actually queueable from Mobile. When the user selects an indexed version, the API must idempotently sync the selected `ktv_song_assets` row into canonical `songs/assets`, then reuse the existing queue, duplicate confirmation, realtime snapshot, and TV playback chain using canonical IDs only. This phase must not introduce `ktv_*` IDs into `queue_entries`, must not bulk import the full indexed library, and must not solve NAS path mapping, streaming, browser playback, or Android TV support; those remain later v1.3 boundaries.

</domain>

<decisions>
## Implementation Decisions

### Mobile Indexed Queue Entry
- **D-01:** Indexed version buttons should show the normal user-facing label `点歌`, not `同步入库` or other internal sync wording.
- **D-02:** While queueing an indexed version, the clicked version button should show an inline `正在加入...` state and be disabled until the command completes.
- **D-03:** After successful sync and queue insertion, the result may remain in the `KTV 索引结果` section, but its button/state should immediately reflect `已点` for the selected song/version context.
- **D-04:** Multi-version indexed results stay expanded as version rows, with each version carrying its own `点歌` button. Do not replace this with a modal or hidden version picker.

### Idempotent Catalog Identity
- **D-05:** `ktv_song_assets.id` is the unique source identity for syncing canonical Assets. Re-queueing the same indexed asset must reuse the same canonical Asset.
- **D-06:** `ktv_songs.id` maps to one canonical Song. Multiple active `ktv_song_assets` rows under the same indexed song should become multiple canonical Assets under that Song.
- **D-07:** When an already-synced indexed asset is queued again, the sync service should read latest `ktv_*` metadata and lightly update canonical rows where appropriate, while preserving existing queue stability.
- **D-08:** Synced canonical records are searchable and queueable immediately after sync. Media readability and real playback proof are not required for Phase 19 and remain Phase 20 responsibilities.

### Failure And Unavailable States
- **D-09:** If a selected indexed asset no longer exists or has become missing, Mobile should keep the indexed result visible but disable queue action with `索引已失效`.
- **D-10:** If the selected indexed asset is already known to have an unreadable or unmapped NAS path, Phase 19 should block queueing and show `文件不可读`. This should remain a queue-time safety check, not full streaming/browser playback verification.
- **D-11:** Database conflicts, invalid source rows, or partial sync failures should roll back the sync and queue insertion together. Mobile gets a clear Chinese error and the queue remains unchanged.
- **D-12:** Admin needs a way to inspect canonical records created from the KTV index, including `ktv_songs.id`, `ktv_song_assets.id`, and original `file_path`.

### Queue Command Contract
- **D-13:** Extend the existing `add-queue-entry` command to accept an indexed queue source instead of adding a separate Mobile command flow.
- **D-14:** The request payload should allow either canonical `songId/assetId` or `indexedAssetId`, but not both. Mobile must not send full indexed metadata or NAS paths.
- **D-15:** Duplicate handling should run after sync through existing canonical Song queue-state semantics. If the synced Song is already in the queue, Mobile should reuse the current duplicate confirmation flow before adding again.
- **D-16:** Automated coverage should include API catalog sync, queue/realtime snapshot behavior, and Mobile indexed queue UI states. Do not rely only on manual UAT for this phase.

### the agent's Discretion
- Exact database storage for source identity is planner discretion, but it must be durable, queryable, and idempotent. Existing `source_records` with provider-style identity is a likely integration point to evaluate.
- Exact canonical `songId` and `assetId` naming is planner discretion, provided IDs remain stable for the same `ktv_songs.id` and `ktv_song_assets.id`.
- Exact metadata mapping defaults are planner discretion, but synced rows must preserve source index identity, file path, title, primary artist, category, extension, size, and parse confidence.
- Exact Admin placement for source identity inspection is planner discretion, but it should stay near Songs/KTV diagnostics rather than becoming a new top-level product surface.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Milestone And Phase Scope
- `.planning/PROJECT.md` - v1.3 product goal, source-of-truth decisions, and the rule that search may read `ktv_*` but queue/playback remain canonical `songs/assets`.
- `.planning/REQUIREMENTS.md` - SYNC-01 through SYNC-04 define the Phase 19 acceptance boundary.
- `.planning/ROADMAP.md` - Phase 19 goal, success criteria, plan split, and dependencies on Phase 18.
- `.planning/STATE.md` - accumulated decisions from v1.2/v1.3, including Phase 18 indexed search boundaries.

### Prior Phase Context
- `.planning/phases/18-ktv-index-read-model-and-diagnostics/18-CONTEXT.md` - read-only indexed search contract, Mobile indexed result shape, Admin diagnostics placement, and source/path visibility rules.
- `.planning/phases/18-ktv-index-read-model-and-diagnostics/18-VERIFICATION.md` - proof that Phase 18 exposes local/indexed/online search sections while indexed results remain nonqueueable.
- `.planning/milestones/v1.2-phases/15-search-queue-playback-and-switching/15-CONTEXT.md` - existing Mobile search, queue boundaries, duplicate confirmation, and playback switching contracts.
- `.planning/milestones/v1.2-phases/16-policy-seam-android-reservation-and-hardening/16-CONTEXT.md` - real media compatibility boundaries and Android TV reservation constraints.

### Current Code Integration Points
- `packages/domain/src/index.ts` - `SongSearchResponse`, indexed search result types, queue state types, source record types, and canonical Song/Asset contracts.
- `apps/api/src/routes/song-search.ts` - existing Mobile search endpoint that returns `local`, `indexed`, and `online` sections.
- `apps/api/src/routes/control-commands.ts` - existing command route for `add-queue-entry`, duplicate/session handling envelope, and command response shape.
- `apps/api/src/modules/playback/session-command-service.ts` - canonical queue mutation, duplicate command handling, snapshot generation, and add-queue validation.
- `apps/api/src/modules/ktv-index/ktv-index-read-repository.ts` - bounded active indexed search and diagnostics row mapping from `ktv_*`.
- `apps/api/src/modules/catalog/repositories/song-repository.ts` - formal catalog search, version option grouping, and canonical search queue-state mapping.
- `apps/api/src/modules/catalog/repositories/asset-repository.ts` - canonical Asset loading and real-MV metadata normalization.
- `apps/api/src/modules/catalog/admission-service.ts` - existing upsert pattern for canonical songs/assets and `source_records`.
- `apps/api/src/db/schema.ts` - canonical `songs`, `assets`, `source_records`, `queue_entries`, and KTV index table schema.
- `apps/mobile-controller/src/runtime/use-room-controller-runtime.ts` - Mobile command orchestration, duplicate confirmation, search refresh, and queue actions.
- `apps/mobile-controller/src/api/client.ts` - Mobile API client for `add-queue-entry`.
- `apps/mobile-controller/src/App.tsx` - Mobile search rendering for local and indexed sections.
- `apps/mobile-controller/src/i18n.tsx` - Chinese-first labels for Mobile queue/search states.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `PgKtvIndexReadRepository.searchIndexedSongs` already returns grouped active indexed results with `indexedSongId` and `indexedAssetId`, but current version options are disabled with `needs_catalog_sync`.
- `registerSongSearchRoutes` already combines formal catalog results, indexed results, online candidates, and effective queue state in one Mobile search response.
- `executeRoomCommand` and `addQueueEntry` already centralize command idempotency, session-version conflict handling, canonical queue validation, duplicate command detection, queue append, snapshot rebuild, and realtime broadcast.
- `PgCatalogAdmissionWriter.promoteApprovedCandidate` shows an existing pattern for upserting canonical `songs/assets` and source records from an external/import source.
- Mobile runtime already has `requestAddSongVersion`, `duplicateConfirm`, `confirmDuplicateAdd`, command error handling, and search debounce/submit flows that can be extended for indexed queue requests.

### Established Patterns
- Backend is authoritative for queueability and room state. Mobile renders API-provided state and sends small commands.
- `queue_entries` stores canonical `song_id` and `asset_id`; it should never store raw indexed IDs.
- User-facing UI defaults to Chinese. Internal sync mechanics should be hidden behind ordinary KTV wording where possible.
- Admin diagnostics can expose raw file paths and source identity; Mobile must not render NAS absolute paths.
- Real-MV search queueability uses server-authored `canQueue`, `queueState`, and `disabledLabel`; indexed results should follow the same pattern after Phase 19.

### Integration Points
- Extend the domain indexed version queue state from only `needs_catalog_sync` to include queueable, queued, syncing/error-disabled states as needed.
- Add a queue-time sync service/repository near catalog or ktv-index boundaries that can atomically read `ktv_*`, upsert canonical `songs/assets`, persist source identity, and return canonical IDs.
- Extend `add-queue-entry` route/body and command execution path to accept `indexedAssetId`, run sync first, then pass canonical IDs into the existing queue logic.
- Update search response mapping so already-synced indexed assets can show `已点`/queue state without exposing canonical implementation details to Mobile.
- Add Admin source inspection through Songs/KTV diagnostics so operators can trace canonical records back to indexed source rows.

</code_context>

<specifics>
## Specific Ideas

- The user wants the feature to feel directly usable: from Mobile search, indexed songs should be点歌-able without manual import or approval.
- The button should be ordinary KTV language (`点歌`) rather than exposing `catalog sync`.
- The selected indexed result should stay visible in the KTV index section after queueing, but state should change immediately so the user sees feedback.
- Known NAS path unreadable/unmapped evidence should block queueing with clear copy, but Phase 20 still owns full media path resolution, streaming, browser playback, and playback-target proof.

</specifics>

<deferred>
## Deferred Ideas

- Full NAS path mapping, file readability preflight, asset gateway streaming, MIME/byte-range behavior, and TV playback target verification are Phase 20.
- Real-mode deployment profiles, operator startup commands, logs, and health checks are Phase 21.
- Real-scene UAT and failure-state hardening are Phase 22.
- Android TV native playback, remux/transcode automation, bulk catalog sync, ranking, user accounts, and online provider acquisition remain outside Phase 19.

</deferred>

---

*Phase: 19-search-and-queue-time-catalog-sync*
*Context gathered: 2026-05-20*
