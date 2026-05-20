# Phase 18: KTV Index Read Model and Diagnostics - Research

**Researched:** 2026-05-20
**Status:** Complete

## Research Question

What needs to be known to plan a safe read-only product surface over the real `ktv_*` index, while preserving the Phase 19 boundary for queue-time catalog sync?

## Existing Shape

- The real index already exists in PostgreSQL through `ktv_index_runs`, `ktv_artists`, `ktv_songs`, `ktv_song_artists`, and `ktv_song_assets`.
- `docs/KTV-FULL-INDEX.md` records the current real library scale: source root `/mnt/nas/KTV歌曲`, 34,385 active media assets, 31,893 songs, 8,568 artists, and low-confidence active rows currently at 0.
- `docs/KTV-FULL-INDEX-INTEGRATION.md` defines the critical read rule: application code must query only active assets with `ktv_song_assets.missing_at is null`.
- Existing Mobile search is centralized in `apps/api/src/routes/song-search.ts` and returns `SongSearchResponse` from `packages/domain/src/index.ts`.
- Existing formal catalog search already groups version options under each song in `PgSongRepository.searchFormalSongs`.
- Admin Songs already has an app-local runtime hook and dense operational layout in `apps/admin/src/songs/use-song-catalog-runtime.ts` and `apps/admin/src/songs/SongCatalogView.tsx`.

## Planning Conclusions

### Read Model Boundary

Create a read-only KTV index repository rather than mixing KTV SQL into route handlers. The repository should live near catalog/search code and expose small methods:

- `getDiagnostics(input)` for latest run, table presence, counts, parse strategy coverage, low-confidence count, indexed root, and bounded NAS sample-read evidence.
- `searchIndexedSongs(input)` for bounded keyword search over active assets.
- `getIndexedSongAssets(songId, input)` only if needed by UI expansion; otherwise `searchIndexedSongs` can return grouped assets in one query.

The repository must not write `songs`, `assets`, `queue_entries`, or any `ktv_*` table. Phase 18 is read-only over KTV index data.

### Search Contract

Extend the existing `/rooms/:roomSlug/songs/search` response instead of adding a second Mobile search route. Keep formal catalog results in `local`, online补歌 in `online`, and add a separate `indexed` section for real KTV index results.

Recommended response shape:

```ts
export interface SongSearchIndexedResult {
  indexedSongId: string;
  title: string;
  artistName: string;
  category: string;
  sourceLabel: "KTV索引";
  matchReason: SongSearchMatchReason | "category";
  versions: SongSearchIndexedVersionOption[];
}

export interface SongSearchIndexedVersionOption {
  indexedAssetId: string;
  displayName: string;
  sourceLabel: "KTV索引";
  extension: string;
  sizeBytes: number | null;
  category: string;
  queueState: "needs_catalog_sync";
  canQueue: false;
  disabledLabel: "需同步入库后可点歌";
}
```

This preserves indexed identity for Phase 19 without introducing raw `ktv_*` IDs into queue commands. Mobile should never receive absolute `file_path`.

### Query Strategy

Search must be bounded and database-driven:

- Normalize the query with existing `normalizeSearchText`.
- Match title, artist, title pinyin, title initials, artist pinyin, artist initials, and category.
- Join `ktv_song_assets` with `missing_at is null`.
- Limit songs first, then return a bounded number of asset versions per song.
- Use parameterized SQL only.
- Do not load the whole library into memory.

The current schema has trigram indexes on normalized names/title and pinyin, plus active asset indexes. Initial implementation can use `LIKE`, equality, and `similarity` over indexed normalized fields with hard limits.

### Admin Diagnostics

Keep diagnostics inside Admin Songs. The API can expose an Admin route such as `GET /admin/ktv-index/diagnostics`, but the UI placement remains the existing Songs workspace.

Raw metrics to return and display:

- table availability for all five `ktv_*` tables;
- latest run id, source root, ssh host, status, files seen, songs upserted, assets upserted, error message, started/finished timestamps;
- active asset count and missing asset count;
- active song count and artist count;
- parse strategy coverage;
- low-confidence count and minimum parse confidence;
- search preview for the Admin query input;
- NAS sample read counts and example paths.

Do not synthesize `healthy`, `degraded`, `blocked`, `ok`, `warning`, or `error` status.

### NAS Readability Sampling

Sampling should be explicit, bounded, read-only, and timeout-safe.

Recommended defaults:

- default sample size: 12 active assets;
- max sample size: 50;
- default per-path timeout: 250 ms;
- max per-path timeout: 1000 ms;
- selection: random rows ordered by `random()` after filtering `missing_at is null`, or deterministic fallback ordered by `updated_at desc` when random sampling is disabled in tests.

The API should call `fs.promises.access(filePath, fs.constants.R_OK)` for sampled absolute paths and race each access with a timeout. Report aggregate counts and examples; never scan the full active library.

Report `unmapped` separately from filesystem failures. In Phase 18, classify a sampled row as `unmapped` when `file_path` is blank, not absolute, or not under the latest index `source_root` when a source root is available. Do not add a full media path resolver in this phase; Phase 20 owns complete NAS path mapping and streaming behavior.

### UI Notes

Admin should be dense and operational, not a landing page. Add a compact diagnostics panel in the Songs workspace using tables/definition lists and an explicit refresh button.

Mobile search should render indexed results as separate grouped results below formal local results. Each indexed version should show source/category/extension and a disabled queue button with the exact copy `需同步入库后可点歌` until Phase 19 implements queue-time sync.

## Test Strategy

Backend:

- Repository tests prove active-only filtering, bounded limits, grouping, match reasons, and diagnostics metric mapping.
- Route tests prove `/rooms/:roomSlug/songs/search` includes `indexed` without breaking `local` and `online`.
- Admin diagnostics route tests prove raw metric serialization and bounded NAS sample behavior.

Frontend:

- Admin tests prove the Songs area renders KTV index diagnostics, raw metric labels, search preview rows, and refresh/sample controls.
- Mobile tests prove indexed groups render, paths are absent, and indexed queue actions are disabled with Chinese copy.

## Scope Guardrails

- Do not create queue entries from `ktv_song_assets` in Phase 18.
- Do not create canonical `songs/assets` rows from indexed results in Phase 18.
- Do not expose `file_path` in Mobile search.
- Do not implement streaming/path resolution for NAS media in Phase 18.
- Do not add a new top-level Admin tab for diagnostics.
- Do not infer an overall health status from raw diagnostics.

## RESEARCH COMPLETE

Phase 18 should be planned as a read-only index read model plus Admin/Mobile visibility layer. Phase 19 should consume the preserved indexed identities to sync selected assets into the formal catalog and make them queueable.
