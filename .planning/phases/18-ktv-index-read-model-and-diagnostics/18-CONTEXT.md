# Phase 18: KTV Index Read Model and Diagnostics - Context

**Gathered:** 2026-05-20
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 18 delivers a safe read-only product surface over the real `ktv_*` index: Admin/operator diagnostics, bounded KTV index search, source labeling, result grouping, and lightweight NAS readability sampling. It must not rewrite the queue/playback architecture or introduce a second ID universe into `queue_entries`. The user wants the real indexed library to become actually usable from Mobile search; because queue-time catalog sync is roadmapped in Phase 19, Phase 18 should prepare the response contracts and UI path so Phase 19 can make indexed versions queueable immediately after sync is implemented.

</domain>

<decisions>
## Implementation Decisions

### Admin Diagnostics Placement
- **D-01:** Keep the KTV index diagnostics inside the existing Admin Songs area/workspace rather than adding a new top-level Admin tab.
- **D-02:** The diagnostics should feel like part of song-library operations: index status, counts, latest run, search preview, and NAS sample-read evidence live near the formal catalog view.
- **D-03:** Do not move this diagnostic surface into Rooms; Rooms remains focused on playback state, queue, TV/mobile presence, pairing, and online task recovery.

### Mobile Search Exposure
- **D-04:** Extend the existing Mobile search flow to include real KTV indexed results, rather than creating a separate user-facing search screen.
- **D-05:** The user wants indexed Mobile search results to become practically usable for点歌. For Phase 18, downstream agents should expose the indexed results and source labels while respecting the phase boundary: queue actions that require canonical `songs/assets` sync belong to Phase 19 unless the roadmap is explicitly revised.
- **D-06:** API contract work in Phase 18 should avoid painting Phase 19 into a corner. Search responses should carry enough indexed identity and version metadata for Phase 19 to resolve the selected `ktv_song_assets` row server-side.

### Search Result Grouping
- **D-07:** Search results should be grouped by song identity, with expandable or nested versions/assets under each song.
- **D-08:** Each version should show useful user/operator metadata such as primary artist, category/version label, extension, and source label. Low-level absolute file paths should not be shown in Mobile.
- **D-09:** Admin diagnostics may expose more detail than Mobile, including file path, parse confidence, active/missing state, latest run, and sample readability evidence.

### Diagnostic Health Presentation
- **D-10:** Do not synthesize `healthy/degraded/blocked` or `ok/warning/error` status in Phase 18.
- **D-11:** Show raw diagnostic metrics directly: table availability, latest run status/time/counts, active/missing asset counts, source root, parse strategy coverage, low-confidence count, and sample-read results.
- **D-12:** Planner may add visual grouping or Chinese labels for readability, but should not hide raw metrics behind a single status judgment.

### NAS Readability Sampling
- **D-13:** Phase 18 should include random or representative sampling of active indexed NAS paths to check API-side file readability.
- **D-14:** Sampling must be lightweight, bounded, read-only, and timeout-safe. Do not scan every active asset for readability in this phase.
- **D-15:** Sampling should report counts and examples for readable, missing, unreadable, and unmapped paths. Full media path resolution and streaming behavior remain Phase 20.

### Scope Boundary For Queueing
- **D-16:** The user explicitly wants the real indexed library to become actually usable, but Phase 18 should not silently absorb Phase 19's queue-time catalog sync responsibility.
- **D-17:** If planning determines that Mobile must show enabled queue buttons in Phase 18, the roadmap should first be updated to merge or move the Phase 19 sync requirements. Otherwise, Phase 18 should show indexed results with clear source/availability and Phase 19 should make them queueable.

### the agent's Discretion
- Exact endpoint names for Admin KTV index diagnostics are planner discretion, as long as Mobile user search is based on the existing `/rooms/:roomSlug/songs/search` flow.
- Exact Admin layout inside Songs is planner discretion; keep it dense, operational, Chinese-first, and consistent with existing Admin catalog styling.
- Exact sample size, timeout, and randomization strategy for NAS readability checks are planner discretion, as long as the check is bounded and safe.
- Exact API field names for indexed result grouping are planner discretion, but must preserve indexed song/asset identity for Phase 19.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Milestone And Phase Scope
- `.planning/PROJECT.md` - v1.3 goal, current milestone target features, and decisions about `ktv_*` search with canonical `songs/assets` queue/playback.
- `.planning/REQUIREMENTS.md` - INDEX-01 through INDEX-04 for Phase 18, plus SYNC requirements that define the queue boundary for Phase 19.
- `.planning/ROADMAP.md` - Phase 18 goal, dependencies, success criteria, and the split between Phase 18 read model and Phase 19 sync.
- `.planning/STATE.md` - current milestone state and accumulated v1.3 decisions.

### KTV Index Design
- `docs/KTV-FULL-INDEX.md` - current real index counts, schema purpose, source root `/mnt/nas/KTV歌曲`, indexing flow, and verification SQL.
- `docs/KTV-FULL-INDEX-INTEGRATION.md` - active-asset query contract, recommended lookup SQL, and guidance not to depend on folder structure for search.
- `apps/api/src/modules/ingest/ktv-full-index.ts` - KTV full index importer and stored field semantics.
- `apps/api/src/modules/ingest/ktv-sample-index.ts` - filename parser, category inference, parse strategy, and parse confidence logic.
- `apps/api/src/db/schema.ts` - `ktv_*` table definitions and indexes.
- `apps/api/src/db/migrations/0008_ktv_full_index.sql` - durable schema migration for KTV full index tables.
- `apps/api/src/db/migrations/0009_ktv_active_asset_indexes.sql` - active asset index migration.

### Existing Search And Admin Patterns
- `packages/domain/src/index.ts` - current `SongSearchResponse`, local result/version option types, and queue state types.
- `apps/api/src/routes/song-search.ts` - existing Mobile search endpoint to extend for indexed results.
- `apps/api/src/modules/catalog/repositories/song-repository.ts` - formal catalog search and version grouping behavior.
- `apps/mobile-controller/src/runtime/use-room-controller-runtime.ts` - Mobile search orchestration and duplicate queue confirmation.
- `apps/mobile-controller/src/App.tsx` - Mobile search rendering and version selection UI.
- `apps/admin/src/App.tsx` - existing Admin tab layout where Songs remains the preferred diagnostics entry.
- `apps/admin/src/songs/SongCatalogView.tsx` - Admin Songs layout and density patterns.
- `apps/admin/src/songs/use-song-catalog-runtime.ts` - Admin Songs data-fetch/mutation runtime hook pattern.
- `apps/admin/src/api/client.ts` - Admin API client pattern for adding diagnostics fetchers.
- `apps/admin/src/i18n.tsx` - Chinese-first Admin copy and language-switch patterns.

### Prior Phase Decisions
- `.planning/milestones/v1.2-phases/15-search-queue-playback-and-switching/15-CONTEXT.md` - Mobile search visibility, queue boundaries, disabled unavailable states, and Admin as detailed diagnostic surface.
- `.planning/milestones/v1.2-phases/16-policy-seam-android-reservation-and-hardening/16-CONTEXT.md` - real media verification, local index/library as real-world evidence, and compatibility preservation.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `apps/api/src/db/schema.ts` already defines `ktv_index_runs`, `ktv_artists`, `ktv_songs`, `ktv_song_artists`, and `ktv_song_assets` plus search/path indexes.
- `apps/api/src/modules/ingest/ktv-full-index.ts` already writes active/missing index state and can inform repository row mapping.
- `apps/api/src/routes/song-search.ts` already centralizes Mobile search; extending it avoids a separate Mobile search surface.
- `packages/domain/src/index.ts` already has `SongSearchResponse` and version-option concepts that can be extended for indexed source labeling.
- `apps/admin/src/songs/use-song-catalog-runtime.ts` and `SongCatalogView.tsx` provide a local Admin runtime-hook plus view pattern suitable for adding a Songs-area diagnostics panel.
- `apps/admin/src/api/client.ts` and `i18n.tsx` provide established fetch and Chinese copy patterns for Admin diagnostics.

### Established Patterns
- Backend remains the source of truth for room/search/queue state; Mobile renders API-authored result state and sends commands.
- Admin pages use app-local runtime hooks rather than pushing query orchestration into page components.
- User-facing UI defaults to Chinese, with English retained through existing i18n dictionaries.
- Existing real-MV work keeps unavailable/preprocess states visible but safe, with detailed reasons reserved for Admin.
- Runtime queue/playback should use canonical `songs/assets`, not raw `ktv_*` IDs.

### Integration Points
- Add a read-only KTV index repository under the API catalog/ingest boundary, using parameterized SQL and `missing_at is null`.
- Extend server dependency wiring to provide the KTV index repository to search and Admin diagnostic routes.
- Extend `SongSearchResponse` or add a compatible indexed-results section so Mobile can render grouped real-index results without queue-time sync yet.
- Add Admin Songs diagnostics client/runtime/view code rather than a new Admin top-level tab.
- Add tests around active-only filtering, bounded search, grouping by indexed song, raw metric serialization, and bounded NAS sample-read reporting.

</code_context>

<specifics>
## Specific Ideas

- User asked to keep diagnostics where they expected it originally: inside Songs, not a new top-level Admin entry.
- User wants Mobile search to be the real user-facing search surface for indexed songs.
- User wants search result granularity as song-grouped results with expandable multiple versions.
- User prefers raw diagnostic metrics over opinionated health-state judgment.
- User wants random sampling of NAS file readability, not a full active-library scan.
- User wants the real indexed library to become practically usable quickly; Phase 19 should be planned immediately after Phase 18 to make indexed results queueable.

</specifics>

<deferred>
## Deferred Ideas

- Making indexed Mobile search results actually queueable through canonical catalog sync is Phase 19 unless the roadmap is revised to merge Phase 18 and Phase 19.
- Full media path resolution, streaming verification, and browser playback proof are Phase 20.
- Real deployment profile and operator workflow are Phase 21.
- Native Android TV, mandatory transcoding/remuxing, full bulk import, and hot-song ranking remain outside Phase 18.

</deferred>

---

*Phase: 18-ktv-index-read-model-and-diagnostics*
*Context gathered: 2026-05-20*
