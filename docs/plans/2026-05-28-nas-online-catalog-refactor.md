# NAS / Online Catalog Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the legacy `songs` / `assets` / `source_records` bridge and make NAS songs queue and play directly from `ktv_songs` / `ktv_song_assets`, while reserving clean `online` source support for a later phase.

**Architecture:** Add source-aware queue and playback contracts, migrate persisted queue rows to direct NAS foreign keys, introduce a source-aware media resolver/gateway, then update search, discovery, queue commands, Web clients, Android TV protocol parsing, Admin, deployment docs, and tests. This is a breaking downtime release with database backup and restore-based rollback.

**Tech Stack:** TypeScript, Fastify, PostgreSQL migrations, `pg`, Vitest, React controller/admin/web-TV clients, Kotlin Android TV client, pnpm workspace, Docker deploy scripts.

---

## Preconditions

- Review design: `docs/plans/2026-05-28-nas-online-catalog-refactor-design.md`.
- Confirmed decisions:
  - Drop old formal import/admission tables in the same release.
  - Use direct NAS streaming first; do not add generated web-compatible copies in this refactor.
- Keep unrelated working tree changes out of this implementation. Before each commit, run:

```bash
git status --short
git diff --cached --name-status
```

Only stage files listed in the task.

---

### Task 1: Add Final Schema Guard Tests

**Files:**
- Modify: `apps/api/src/test/library-ingest-schema.test.ts`
- Modify: `apps/api/src/test/real-mv-schema.test.ts`
- Create: `apps/api/src/test/nas-online-catalog-schema.test.ts`
- Reference: `apps/api/src/db/schema.ts`
- Reference: `apps/api/src/db/migrations/0001_media_contract.sql`
- Reference: `apps/api/src/db/migrations/0016_song_cover_cache.sql`

**Step 1: Write failing schema tests**

Create `apps/api/src/test/nas-online-catalog-schema.test.ts` with assertions like:

```ts
import { describe, expect, it } from "vitest";
import { schemaSql } from "../db/schema.js";

describe("NAS / online catalog final schema", () => {
  it("removes legacy formal catalog tables from the final schema", () => {
    expect(schemaSql).not.toContain("CREATE TABLE IF NOT EXISTS songs");
    expect(schemaSql).not.toContain("CREATE TABLE IF NOT EXISTS assets");
    expect(schemaSql).not.toContain("CREATE TABLE IF NOT EXISTS source_records");
  });

  it("stores queue entries by source-native identities", () => {
    expect(schemaSql).toContain("source_type text NOT NULL");
    expect(schemaSql).toContain("nas_song_id text");
    expect(schemaSql).toContain("nas_asset_id text");
    expect(schemaSql).toContain("online_song_id text");
    expect(schemaSql).toContain("online_asset_id text");
    expect(schemaSql).toContain("queue_entries_source_identity_ck");
    expect(schemaSql).toContain("queue_entries_nas_asset_song_fk");
  });

  it("adds online placeholders and removes old active asset state", () => {
    expect(schemaSql).toContain("CREATE TABLE IF NOT EXISTS online_songs");
    expect(schemaSql).toContain("CREATE TABLE IF NOT EXISTS online_song_assets");
    expect(schemaSql).not.toContain("active_asset_id text REFERENCES assets");
  });

  it("uses nas and online as cover cache source kinds", () => {
    expect(schemaSql).toContain("source_kind text NOT NULL CHECK (source_kind IN ('nas', 'online'))");
    expect(schemaSql).not.toContain("'ktv-index'");
    expect(schemaSql).not.toContain("'formal'");
  });
});
```

Update old schema tests that currently require `source_records`, `songs`, or `assets` so they assert removal or are deleted if the tested feature is retired.

**Step 2: Run the tests and verify they fail**

Run:

```bash
pnpm -F @home-ktv/api test -- src/test/nas-online-catalog-schema.test.ts src/test/library-ingest-schema.test.ts src/test/real-mv-schema.test.ts
```

Expected: FAIL because `schema.ts` still contains legacy `songs`, `assets`, `source_records`, old queue FKs, and old cover source kinds.

**Step 3: Commit only the failing tests**

Do not commit failing tests to `main` unless this is in an isolated implementation branch. If working on `main`, keep this task uncommitted until Task 2 makes it pass.

---

### Task 2: Add Database Migration And Update Final Schema

**Files:**
- Create: `apps/api/src/db/migrations/0017_nas_online_catalog_refactor.sql`
- Modify: `apps/api/src/db/schema.ts`
- Modify: `apps/api/src/test/nas-online-catalog-schema.test.ts`
- Modify or delete: `apps/api/src/test/library-ingest-schema.test.ts`
- Modify or delete: `apps/api/src/test/catalog-contracts.test.ts`
- Modify or delete: `apps/api/src/test/ktv-catalog-sync-service.test.ts`

**Step 1: Write migration-level tests**

If no migration harness exists for executing SQL, add string-level tests first in `nas-online-catalog-schema.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migrationSql = readFileSync(
  resolve(process.cwd(), "src/db/migrations/0017_nas_online_catalog_refactor.sql"),
  "utf8"
);

it("migrates legacy queue rows before dropping old columns", () => {
  expect(migrationSql).toContain("UPDATE queue_entries qe");
  expect(migrationSql).toContain("FROM source_records sr");
  expect(migrationSql).toContain("regexp_replace(qe.asset_id, '^asset-ktv-'");
  expect(migrationSql).toContain("ALTER TABLE queue_entries DROP COLUMN IF EXISTS song_id");
  expect(migrationSql).toContain("ALTER TABLE queue_entries DROP COLUMN IF EXISTS asset_id");
});
```

**Step 2: Implement `0017_nas_online_catalog_refactor.sql`**

Migration order must be explicit:

1. Create `online_songs`.
2. Create `online_song_assets`.
3. Add nullable `source_type`, `nas_song_id`, `nas_asset_id`, `online_song_id`, `online_asset_id` to `queue_entries`.
4. Backfill from `source_records`.
5. Backfill from `asset-ktv-*` fallback.
6. Mark unmapped active rows failed.
7. Delete or archive unmapped non-active rows.
8. Add composite unique indexes:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS ktv_song_assets_id_song_id_uq
  ON ktv_song_assets(id, song_id);
```

9. Add queue constraints and FKs.
10. Drop old queue FKs and columns.
11. Drop `playback_sessions.active_asset_id`.
12. Migrate `song_cover_cache` source kinds.
13. Replace `song_cover_cache_source_kind_check`.
14. Replace `candidate_tasks.ready_asset_id` with `ready_source_type` and `ready_online_asset_id`.
15. Drop import/admission tables:

```sql
DROP TABLE IF EXISTS source_records;
DROP TABLE IF EXISTS import_candidate_files;
DROP TABLE IF EXISTS import_candidates;
DROP TABLE IF EXISTS import_files;
DROP TABLE IF EXISTS import_scan_runs;
```

16. Drop legacy catalog tables:

```sql
DROP TABLE IF EXISTS assets;
DROP TABLE IF EXISTS songs;
```

**Step 3: Update `apps/api/src/db/schema.ts`**

Make `schema.ts` match the final schema:

- Remove `tableNames.songs`, `tableNames.assets`, `tableNames.sourceRecords`.
- Remove `SongRow`, `AssetRow`, and import/admission row types if no longer used.
- Add `OnlineSongRow`, `OnlineSongAssetRow`.
- Update `QueueEntryRow` to source-aware fields.
- Update `PlaybackSessionRow` to remove `active_asset_id`.
- Update `SongCoverCache` SQL block to `nas | online`.

**Step 4: Run schema tests**

Run:

```bash
pnpm -F @home-ktv/api test -- src/test/nas-online-catalog-schema.test.ts src/test/library-ingest-schema.test.ts src/test/real-mv-schema.test.ts
```

Expected: PASS for final schema checks. Tests for retired import/admission schema should be deleted or rewritten to assert retirement.

**Step 5: Commit**

```bash
git add apps/api/src/db/migrations/0017_nas_online_catalog_refactor.sql apps/api/src/db/schema.ts apps/api/src/test/nas-online-catalog-schema.test.ts apps/api/src/test/library-ingest-schema.test.ts apps/api/src/test/real-mv-schema.test.ts apps/api/src/test/catalog-contracts.test.ts apps/api/src/test/ktv-catalog-sync-service.test.ts
git commit -m "refactor(api): add source-aware catalog schema"
```

---

### Task 3: Update Domain And Player Contracts

**Files:**
- Modify: `packages/domain/src/index.ts`
- Modify: `packages/player-contracts/src/index.ts`
- Modify: `packages/protocol/src/index.ts` if telemetry contracts reference asset identity there
- Test: existing package tests if present
- Test: `apps/api/src/test/session-engine.test.ts`
- Test: `apps/tv-web/src/test/*.test.tsx`
- Test: `clients/android-tv/app/src/test/java/com/liuyue/homektv/PlayerContractsJsonTest.kt`

**Step 1: Write failing contract tests**

In the relevant TS tests, assert source-aware queue and playback contract shape:

```ts
const target: PlaybackTarget = {
  roomId: "living-room",
  sessionVersion: 1,
  queueEntryId: "queue-1",
  sourceType: "nas",
  songId: "ktv-song-1",
  assetId: "ktv-asset-1",
  currentQueueEntryPreview: { queueEntryId: "queue-1", songTitle: "晴天", artistName: "周杰伦" },
  playbackUrl: "/media/nas/ktv-asset-1",
  resumePositionMs: 0,
  vocalMode: "instrumental",
  switchFamily: null,
  nextQueueEntryPreview: null
};
expect(target.sourceType).toBe("nas");
```

In Android `PlayerContractsJsonTest.kt`, add JSON containing `"sourceType": "nas"` and assert it parses.

**Step 2: Update TypeScript contracts**

Add:

```ts
export type SongSourceType = "nas" | "online";

export interface MediaSourceRef {
  sourceType: SongSourceType;
  songId: string;
  assetId: string;
}
```

Update `QueueEntry`, `RoomQueueEntryPreview`, `PlaybackTarget`, `SwitchTarget`, and telemetry payloads to include `sourceType` where relevant.

**Step 3: Preserve temporary compatibility**

For TV telemetry routes, make `sourceType` optional in request bodies for one release. Runtime should infer from queue entry when omitted.

**Step 4: Run contract tests**

Run:

```bash
pnpm -F @home-ktv/domain test
pnpm -F @home-ktv/player-contracts test
pnpm -F @home-ktv/api typecheck
```

If a package has no test script, run:

```bash
pnpm -F @home-ktv/api typecheck
```

Expected: Type errors will guide all old shape references that still need migration.

**Step 5: Commit**

```bash
git add packages/domain/src/index.ts packages/player-contracts/src/index.ts packages/protocol/src/index.ts apps/api/src/test/session-engine.test.ts clients/android-tv/app/src/test/java/com/liuyue/homektv/PlayerContractsJsonTest.kt
git commit -m "refactor(contracts): add source-aware media identity"
```

---

### Task 4: Refactor Queue Entry Repository

**Files:**
- Modify: `apps/api/src/modules/playback/repositories/queue-entry-repository.ts`
- Modify: `apps/api/src/test/room-queue-commands.test.ts`
- Modify: `apps/api/src/test/song-discovery-routes.test.ts`
- Modify: `apps/api/src/test/song-search-routes.test.ts`

**Step 1: Write failing repository tests**

Add tests that `PgQueueEntryRepository.append` inserts source-aware NAS columns and maps rows into `QueueEntry.source`:

```ts
await repository.append({
  roomId: "living-room",
  source: { sourceType: "nas", songId: "ktv-song-1", assetId: "ktv-asset-1" },
  requestedBy: "phone-a",
  queuePosition: 1
});
expect(db.lastSql).toContain("source_type, nas_song_id, nas_asset_id");
```

Add a count test:

```ts
const counts = await repository.listGlobalSongRequestCounts([
  { sourceType: "nas", songId: "ktv-song-1" }
]);
expect(counts.get("nas:ktv-song-1")).toBe(3);
```

**Step 2: Update repository types**

Change `AppendQueueEntryInput` from `songId` / `assetId` to:

```ts
source: MediaSourceRef;
```

Update mapper:

```ts
function mapQueueEntryRow(row: QueueEntryRow): QueueEntry {
  return {
    id: row.id,
    roomId: row.room_id as RoomId,
    source: sourceRefFromQueueRow(row),
    ...
  };
}
```

**Step 3: Update SQL**

All SELECT statements should return:

```sql
source_type, nas_song_id, nas_asset_id, online_song_id, online_asset_id
```

`append` should insert the correct source columns based on `input.source.sourceType`.

`listGlobalSongRequestCounts` should group by source-native song id:

```sql
SELECT nas_song_id AS song_id, COUNT(*) AS request_count
FROM queue_entries
WHERE source_type = 'nas'
  AND nas_song_id = ANY($1::text[])
  AND status <> 'removed'
GROUP BY nas_song_id
```

Keep online counts unimplemented until online playback is added.

**Step 4: Update in-memory repository**

Update `InMemoryQueueEntryRepository` to store `QueueEntry.source` and count by source.

**Step 5: Run tests**

Run:

```bash
pnpm -F @home-ktv/api test -- src/test/room-queue-commands.test.ts src/test/song-discovery-routes.test.ts src/test/song-search-routes.test.ts
pnpm -F @home-ktv/api typecheck
```

Expected: queue repository tests pass; dependent tests may still fail until playback/search routes are migrated. Do not proceed if typecheck has repository-level errors.

**Step 6: Commit**

```bash
git add apps/api/src/modules/playback/repositories/queue-entry-repository.ts apps/api/src/test/room-queue-commands.test.ts apps/api/src/test/song-discovery-routes.test.ts apps/api/src/test/song-search-routes.test.ts
git commit -m "refactor(api): store queue entries by source identity"
```

---

### Task 5: Add NAS Playable Media Repository

**Files:**
- Create: `apps/api/src/modules/media/media-source-ref.ts`
- Create: `apps/api/src/modules/media/playable-media-repository.ts`
- Create: `apps/api/src/modules/media/nas-playable-media-repository.ts`
- Create: `apps/api/src/test/nas-playable-media-repository.test.ts`
- Reference: `apps/api/src/modules/catalog/ktv-catalog-sync-service.ts`
- Reference: `apps/api/src/modules/media/real-mv-compatibility.ts`
- Reference: `apps/api/src/modules/assets/media-path-mapping.ts`

**Step 1: Write failing tests**

Test cases:

- Resolves a NAS asset and joins its song title/artist.
- Rejects `missing_at` rows.
- Reads `mediaInfoSummary` from `technical_metadata.mediaInfoSummary`.
- Infers original/instrumental track roles with current fallback logic.
- Returns `playbackProfile.kind = "single_file_audio_tracks"`.
- Returns unavailable when audio tracks are missing.

Example:

```ts
const asset = await repository.findPlayableBySource({
  sourceType: "nas",
  assetId: "ktv-asset-1"
});
expect(asset).toMatchObject({
  sourceType: "nas",
  songId: "ktv-song-1",
  assetId: "ktv-asset-1",
  title: "晴天",
  artistName: "周杰伦",
  playbackProfile: { kind: "single_file_audio_tracks" }
});
```

**Step 2: Implement shared interfaces**

`media-source-ref.ts`:

```ts
export interface MediaSourceRef {
  sourceType: "nas" | "online";
  songId: string;
  assetId: string;
}
```

`playable-media-repository.ts`:

```ts
export interface PlayableMediaAsset {
  sourceType: "nas" | "online";
  songId: string;
  assetId: string;
  title: string;
  artistName: string;
  displayName: string;
  filePath: string;
  status: "ready" | "unavailable" | "failed" | "stale";
  durationMs: number;
  compatibilityStatus: CompatibilityStatus;
  compatibilityReasons: readonly CompatibilityReason[];
  mediaInfoSummary: MediaInfoSummary;
  mediaInfoProvenance: MediaInfoProvenance;
  trackRoles: TrackRoles;
  playbackProfile: PlaybackProfile;
}
```

**Step 3: Implement NAS repository**

Query:

```sql
SELECT a.id AS asset_id,
       a.song_id,
       a.file_path,
       a.file_name,
       a.extension,
       a.size_bytes,
       a.technical_status,
       a.technical_metadata,
       a.missing_at,
       s.title,
       s.primary_artist_name
FROM ktv_song_assets a
JOIN ktv_songs s ON s.id = a.song_id
WHERE a.id = $1
LIMIT 1
```

Reuse track role inference from `ktv-catalog-sync-service.ts`, then delete duplication later when sync service is removed.

**Step 4: Run tests**

Run:

```bash
pnpm -F @home-ktv/api test -- src/test/nas-playable-media-repository.test.ts
pnpm -F @home-ktv/api typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/modules/media/media-source-ref.ts apps/api/src/modules/media/playable-media-repository.ts apps/api/src/modules/media/nas-playable-media-repository.ts apps/api/src/test/nas-playable-media-repository.test.ts
git commit -m "feat(api): resolve NAS assets for playback"
```

---

### Task 6: Replace AssetGateway With Source-Aware MediaGateway

**Files:**
- Create: `apps/api/src/modules/media/media-gateway.ts`
- Modify: `apps/api/src/routes/media.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/test/ktv-index-raw-media-route.test.ts`
- Create: `apps/api/src/test/nas-media-route.test.ts`
- Keep temporarily: `apps/api/src/modules/assets/asset-gateway.ts` until no imports remain

**Step 1: Write failing media route tests**

Add `nas-media-route.test.ts`:

```ts
it("streams NAS media through /media/nas/:assetId", async () => {
  const response = await server.inject({
    method: "GET",
    url: "/media/nas/ktv-asset-1",
    headers: { range: "bytes=0-3" }
  });
  expect(response.statusCode).toBe(206);
  expect(response.headers["accept-ranges"]).toBe("bytes");
});
```

**Step 2: Implement `MediaGateway`**

It should expose:

```ts
createPlaybackUrl(ref: MediaSourceRef): string;
resolveForStreaming(ref: Pick<MediaSourceRef, "sourceType" | "assetId">): Promise<MediaGatewayResolution>;
```

For `nas`, use `PlayableMediaRepository` plus `MediaPathResolver`.

For `online`, return `ONLINE_PLAYBACK_NOT_IMPLEMENTED` or `MEDIA_SOURCE_NOT_READY`.

**Step 3: Update media route**

Add:

```text
GET /media/nas/:assetId
GET /media/online/:assetId
```

Keep `/media/ktv-index/:indexedAssetId/raw` for admin diagnostics only.

Retire `/media/:assetId` after all clients use source-aware playback URLs.

**Step 4: Run tests**

Run:

```bash
pnpm -F @home-ktv/api test -- src/test/nas-media-route.test.ts src/test/ktv-index-raw-media-route.test.ts
pnpm -F @home-ktv/api typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/modules/media/media-gateway.ts apps/api/src/routes/media.ts apps/api/src/server.ts apps/api/src/test/nas-media-route.test.ts apps/api/src/test/ktv-index-raw-media-route.test.ts
git commit -m "feat(api): stream source-aware NAS media"
```

---

### Task 7: Refactor Playback Session, Target, Switch, And Player Routes

**Files:**
- Modify: `apps/api/src/modules/playback/repositories/playback-session-repository.ts`
- Modify: `apps/api/src/modules/playback/build-playback-target.ts`
- Modify: `apps/api/src/modules/playback/build-switch-target.ts`
- Modify: `apps/api/src/modules/playback/apply-switch-transition.ts`
- Modify: `apps/api/src/modules/playback/apply-reconnect-recovery.ts`
- Modify: `apps/api/src/routes/player.ts`
- Modify: `apps/api/src/routes/room-snapshots.ts`
- Modify: `apps/api/src/test/build-playback-target.test.ts`
- Modify: `apps/api/src/test/build-switch-target.test.ts`
- Modify: `apps/api/src/test/player-runtime-contract.test.ts`
- Modify: `apps/api/src/test/player-failure-recovery.test.ts`

**Step 1: Write failing playback target tests**

Assert `buildPlaybackTarget` returns source-aware NAS target:

```ts
expect(target).toMatchObject({
  sourceType: "nas",
  songId: "ktv-song-1",
  assetId: "ktv-asset-1",
  playbackUrl: "http://ktv.local/media/nas/ktv-asset-1",
  playbackProfile: { kind: "single_file_audio_tracks" }
});
```

Assert `PlaybackSessionRepository.startQueueEntry` no longer requires `activeAssetId`.

**Step 2: Remove database active asset dependency**

Update `StartQueueEntryInput`:

```ts
export interface StartQueueEntryInput {
  roomId: RoomId;
  queueEntryId: QueueEntryId;
  targetVocalMode?: VocalMode;
  playerState?: PlayerState;
  playerPositionMs?: number;
  nextQueueEntryId?: QueueEntryId | null;
  mediaStartedAt?: Date | null;
}
```

Remove `active_asset_id` from SELECT/UPDATE/RETURNING SQL.

**Step 3: Update target builders**

`buildPlaybackTarget` should resolve the queue entry source through `PlayableMediaRepository`, not through `songs` and `assets`.

`buildSwitchTarget` should return audio-track switch targets for NAS:

```ts
{
  switchKind: "audio_track",
  fromAssetId: current.assetId,
  toAssetId: current.assetId,
  sourceType: "nas",
  selectedTrackRef: ...
}
```

**Step 4: Update player routes**

For loading/playing/ended/failed telemetry:

- Accept optional `sourceType`.
- If missing, infer from queue entry.
- Validate reported asset id matches the queue entry source asset.

**Step 5: Run tests**

Run:

```bash
pnpm -F @home-ktv/api test -- src/test/build-playback-target.test.ts src/test/build-switch-target.test.ts src/test/player-runtime-contract.test.ts src/test/player-failure-recovery.test.ts
pnpm -F @home-ktv/api typecheck
```

Expected: PASS.

**Step 6: Commit**

```bash
git add apps/api/src/modules/playback/repositories/playback-session-repository.ts apps/api/src/modules/playback/build-playback-target.ts apps/api/src/modules/playback/build-switch-target.ts apps/api/src/modules/playback/apply-switch-transition.ts apps/api/src/modules/playback/apply-reconnect-recovery.ts apps/api/src/routes/player.ts apps/api/src/routes/room-snapshots.ts apps/api/src/test/build-playback-target.test.ts apps/api/src/test/build-switch-target.test.ts apps/api/src/test/player-runtime-contract.test.ts apps/api/src/test/player-failure-recovery.test.ts
git commit -m "refactor(api): build playback from source-aware queue entries"
```

---

### Task 8: Rewrite Add Queue Command And Remove Sync Bridge

**Files:**
- Modify: `apps/api/src/routes/control-commands.ts`
- Modify: `apps/api/src/modules/playback/session-command-service.ts`
- Delete: `apps/api/src/modules/playback/indexed-queue-command-service.ts`
- Delete: `apps/api/src/modules/catalog/ktv-catalog-sync-service.ts`
- Delete or rewrite: `apps/api/src/test/indexed-queue-command.test.ts`
- Delete or rewrite: `apps/api/src/test/ktv-catalog-sync-service.test.ts`
- Modify: `apps/api/src/test/room-queue-commands.test.ts`

**Step 1: Write failing command route tests**

Add cases:

```ts
await server.inject({
  method: "POST",
  url: "/rooms/living-room/commands/add-queue-entry",
  payload: {
    commandId: "cmd-1",
    sessionVersion: 1,
    deviceId: "phone-a",
    sourceType: "nas",
    assetId: "ktv-asset-1"
  }
});
```

Expected accepted result and fresh snapshot queue row:

```ts
expect(body.status).toBe("accepted");
expect(body.snapshot.queue[0]).toMatchObject({
  sourceType: "nas",
  songId: "ktv-song-1",
  assetId: "ktv-asset-1",
  songTitle: "晴天"
});
```

Add rejection tests:

- stale NAS asset
- missing NAS asset
- `sourceType: "online"` returns `ONLINE_PLAYBACK_NOT_IMPLEMENTED`
- old `indexedAssetId` body returns `INVALID_QUEUE_SOURCE` or `INVALID_COMMAND_PAYLOAD`

**Step 2: Update route payload**

Replace:

```ts
songId?: string;
assetId?: string;
indexedAssetId?: string;
```

with:

```ts
sourceType?: "nas" | "online";
assetId?: string;
```

**Step 3: Update command service**

`addQueueEntry` should:

1. Validate `sourceType`.
2. Resolve playable media by source and asset id.
3. Reject not queueable statuses.
4. Resolve preferred vocal mode.
5. Append source-aware queue entry.
6. Sync playback session without active asset column.

**Step 4: Remove bridge services**

Delete sync services and server wiring:

```text
PgIndexedQueueCommandService
PgKtvCatalogSyncService
indexedQueueCommands dependency
queueAdmissionSource
```

**Step 5: Run tests**

Run:

```bash
pnpm -F @home-ktv/api test -- src/test/room-queue-commands.test.ts src/test/indexed-queue-command.test.ts src/test/ktv-catalog-sync-service.test.ts
pnpm -F @home-ktv/api typecheck
```

Expected: bridge tests should be deleted or replaced with source-aware command tests; final run PASS.

**Step 6: Commit**

```bash
git add apps/api/src/routes/control-commands.ts apps/api/src/modules/playback/session-command-service.ts apps/api/src/modules/playback/indexed-queue-command-service.ts apps/api/src/modules/catalog/ktv-catalog-sync-service.ts apps/api/src/test/indexed-queue-command.test.ts apps/api/src/test/ktv-catalog-sync-service.test.ts apps/api/src/test/room-queue-commands.test.ts
git commit -m "refactor(api): queue NAS assets without catalog sync"
```

---

### Task 9: Refactor Search, Discovery, Covers, And Recommendation Counts

**Files:**
- Modify or replace: `apps/api/src/modules/ktv-index/ktv-index-read-repository.ts`
- Create: `apps/api/src/modules/search/nas-song-search-repository.ts`
- Modify: `apps/api/src/routes/song-search.ts`
- Modify: `apps/api/src/routes/song-discovery.ts`
- Modify: `apps/api/src/modules/covers/types.ts`
- Modify: `apps/api/src/modules/covers/song-cover-cache-repository.ts`
- Modify: `apps/api/src/scripts/song-covers.ts`
- Modify: `apps/api/src/scripts/song-cover-coverage.ts`
- Modify: `apps/api/src/test/song-search-routes.test.ts`
- Modify: `apps/api/src/test/song-discovery-routes.test.ts`
- Modify: `apps/api/src/test/song-cover-cache-schema.test.ts`
- Modify: `apps/api/src/test/song-cover-coverage-cli.test.ts`

**Step 1: Write failing route tests**

Search should return:

```ts
expect(body).toMatchObject({
  query: "晴天",
  nas: {
    status: "available",
    results: [
      {
        songId: "ktv-song-1",
        versions: [{ assetId: "ktv-asset-1" }]
      }
    ]
  }
});
expect(body).not.toHaveProperty("local");
expect(body).not.toHaveProperty("indexed");
```

Discovery should return:

```ts
expect(body.recommended[0]).toMatchObject({
  source: "nas",
  songId: "ktv-song-1",
  versions: [{ assetId: "ktv-asset-1" }]
});
```

Cover lookup should use `{ source: "nas", sourceSongId: "ktv-song-1" }`.

**Step 2: Rename API-level KTV index search to NAS search**

The SQL may still query `ktv_songs` and `ktv_song_assets`, but exported route contracts should say NAS.

Keep Admin diagnostics using KTV index naming only where it describes the indexing subsystem.

**Step 3: Update queue-state logic**

Queued state should compare NAS asset ids directly from source-aware queue entries:

```ts
const queuedNasAssetIds = queue
  .filter((entry) => entry.source.sourceType === "nas")
  .map((entry) => entry.source.assetId);
```

No `source_records` lookup.

**Step 4: Update recommendation counts**

Use `source_type='nas'` and `nas_song_id`.

**Step 5: Update cover scripts**

Rename CLI options:

```text
--source nas
```

Remove `formal` and `ktv-index` choices.

**Step 6: Run tests**

Run:

```bash
pnpm -F @home-ktv/api test -- src/test/song-search-routes.test.ts src/test/song-discovery-routes.test.ts src/test/song-cover-cache-schema.test.ts src/test/song-cover-coverage-cli.test.ts
pnpm -F @home-ktv/api typecheck
```

Expected: PASS.

**Step 7: Commit**

```bash
git add apps/api/src/modules/ktv-index/ktv-index-read-repository.ts apps/api/src/modules/search/nas-song-search-repository.ts apps/api/src/routes/song-search.ts apps/api/src/routes/song-discovery.ts apps/api/src/modules/covers/types.ts apps/api/src/modules/covers/song-cover-cache-repository.ts apps/api/src/scripts/song-covers.ts apps/api/src/scripts/song-cover-coverage.ts apps/api/src/test/song-search-routes.test.ts apps/api/src/test/song-discovery-routes.test.ts apps/api/src/test/song-cover-cache-schema.test.ts apps/api/src/test/song-cover-coverage-cli.test.ts
git commit -m "refactor(api): expose NAS search and discovery"
```

---

### Task 10: Remove Formal Catalog, Import Routes, And Old Repositories

**Files:**
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/runtime/pg-runtime-repositories.ts`
- Delete: `apps/api/src/routes/available-songs.ts`
- Delete: `apps/api/src/routes/admin-catalog.ts`
- Delete: `apps/api/src/routes/admin-imports.ts`
- Delete or archive: `apps/api/src/modules/catalog/admission-service.ts`
- Delete or archive: `apps/api/src/modules/catalog/repositories/song-repository.ts`
- Delete or archive: `apps/api/src/modules/catalog/repositories/asset-repository.ts`
- Delete or archive: `apps/api/src/runtime/local-media-catalog.ts`
- Delete or rewrite tests:
  - `apps/api/src/test/admin-catalog-routes.test.ts`
  - `apps/api/src/test/admin-imports-routes.test.ts`
  - `apps/api/src/test/catalog-admission.test.ts`
  - `apps/api/src/test/catalog-search-repository.test.ts`
  - `apps/api/src/test/local-media-catalog.test.ts`
  - `apps/api/src/test/local-media-catalog-routes.test.ts`
  - `apps/api/src/test/song-json-consistency-validator.test.ts`

**Step 1: Write server wiring guard test**

Add or update a route/server test asserting retired endpoints are gone:

```ts
expect((await server.inject("/rooms/living-room/available-songs")).statusCode).toBe(404);
expect((await server.inject("/admin/catalog/songs")).statusCode).toBe(404);
```

**Step 2: Remove route registration**

Remove imports and `register*` calls for old formal catalog/import/available-songs routes.

**Step 3: Remove repositories from runtime container**

`RuntimeRepositories` should no longer expose production `songs` and `assets`. It should expose `playableMedia` and NAS search repositories.

**Step 4: Delete retired modules and tests**

Delete tests for retired product behavior. Keep low-level helpers only if still used by NAS indexing or probes.

**Step 5: Run tests**

Run:

```bash
pnpm -F @home-ktv/api test
pnpm -F @home-ktv/api typecheck
```

Expected: API tests PASS. This may require several small commits if deletion exposes many stale imports.

**Step 6: Commit**

```bash
git add apps/api/src/server.ts apps/api/src/runtime/pg-runtime-repositories.ts apps/api/src/routes/available-songs.ts apps/api/src/routes/admin-catalog.ts apps/api/src/routes/admin-imports.ts apps/api/src/modules/catalog apps/api/src/runtime/local-media-catalog.ts apps/api/src/test
git commit -m "refactor(api): remove formal catalog runtime"
```

---

### Task 11: Update Controller Web Client

**Files:**
- Modify: `apps/controller/src/api/client.ts`
- Modify: `apps/controller/src/runtime/use-room-controller-runtime.ts`
- Modify: `apps/controller/src/App.tsx`
- Modify: `apps/controller/src/i18n.tsx`
- Modify: `apps/controller/src/test/controller.test.tsx`
- Modify: `apps/controller/src/App.css` only if CSS class names change

**Step 1: Write failing controller tests**

Update tests to assert:

```ts
expect(addRequest?.body).toMatchObject({
  sourceType: "nas",
  assetId: "ktv-asset-discovery-sunny"
});
expect(addRequest?.body).not.toHaveProperty("indexedAssetId");
expect(addRequest?.body).not.toHaveProperty("songId");
```

Also assert UI no longer shows KTV index wording in controller:

```ts
expect(screen.queryByText(/KTV 索引/)).toBeNull();
expect(screen.getByText(/NAS 曲库/)).toBeTruthy();
```

**Step 2: Update API client**

Replace union:

```ts
{ songId; assetId? } | { indexedAssetId }
```

with:

```ts
{ sourceType: "nas" | "online"; assetId: string }
```

**Step 3: Update runtime**

Rename:

```text
pendingIndexedAssetId -> pendingNasAssetId
requestAddIndexedAsset -> requestAddNasAsset
duplicate kind "indexed" -> "nas"
```

**Step 4: Update rendering**

Read `songSearch.nas.results` and `discovery.source === "nas"`.

Use version `assetId`, not `indexedAssetId`.

**Step 5: Run tests**

Run:

```bash
pnpm -F @home-ktv/controller test
pnpm -F @home-ktv/controller typecheck
```

Expected: PASS.

**Step 6: Commit**

```bash
git add apps/controller/src/api/client.ts apps/controller/src/runtime/use-room-controller-runtime.ts apps/controller/src/App.tsx apps/controller/src/i18n.tsx apps/controller/src/test/controller.test.tsx apps/controller/src/App.css
git commit -m "refactor(controller): queue NAS songs by source asset"
```

---

### Task 12: Update TV Web And Android TV Protocol Compatibility

**Files:**
- Modify: `apps/tv-web/src/runtime/active-playback-controller.ts`
- Modify: `apps/tv-web/src/runtime/switch-controller.ts`
- Modify: `apps/tv-web/src/runtime/use-tv-playback-runtime.ts`
- Modify: `apps/tv-web/src/runtime/video-pool.ts` if target identity is stored there
- Modify: `apps/tv-web/src/test/*.test.tsx`
- Modify: `clients/android-tv/app/src/main/java/com/liuyue/homektv/PlayerContracts.kt`
- Modify: `clients/android-tv/app/src/main/java/com/liuyue/homektv/PlayerContractsJson.kt`
- Modify: `clients/android-tv/app/src/main/java/com/liuyue/homektv/PlayerApiPayloads.kt`
- Modify: `clients/android-tv/app/src/main/java/com/liuyue/homektv/RoomPlaybackDecision.kt`
- Modify: `clients/android-tv/app/src/main/java/com/liuyue/homektv/MainActivity.kt`
- Modify: `clients/android-tv/app/src/test/java/com/liuyue/homektv/*.kt`

**Step 1: Write failing Web TV tests**

Add target identity test:

```ts
const oldTarget = playbackTarget({ sourceType: "nas", assetId: "same" });
const newTarget = playbackTarget({ sourceType: "online", assetId: "same" });
expect(isSamePlaybackTarget(oldTarget, newTarget)).toBe(false);
```

If no helper exists, add one near runtime code.

**Step 2: Update Web TV telemetry**

Ended/failed/loading/playing payloads should include `sourceType: target.sourceType`.

**Step 3: Write failing Android tests**

Update `PlayerContractsJsonTest.kt`:

```kotlin
assertEquals("nas", target.sourceType)
```

Update `PlayerApiPayloadsTest.kt`:

```kotlin
assertEquals("nas", json.getString("sourceType"))
```

Update `RoomPlaybackDecisionTest.kt` so source type differences trigger target change.

**Step 4: Update Android implementation**

- Add `sourceType: String = "nas"` to playback target data class.
- Parse optional `sourceType`, defaulting to `"nas"`.
- Include source type in player API payloads.
- Compare `queueEntryId + sourceType + assetId`.
- Keep `playbackUrl` opaque.

**Step 5: Run tests**

Run:

```bash
pnpm -F @home-ktv/tv-web test
pnpm -F @home-ktv/tv-web typecheck
cd clients/android-tv && ./gradlew testDebugUnitTest
```

Expected: PASS.

**Step 6: Commit**

```bash
git add apps/tv-web/src clients/android-tv/app/src
git commit -m "refactor(tv): handle source-aware playback targets"
```

---

### Task 13: Update Admin App To NAS Library Boundary

**Files:**
- Modify: `apps/admin/src/App.tsx`
- Modify: `apps/admin/src/api/client.ts`
- Modify: `apps/admin/src/songs/SongCatalogView.tsx`
- Modify: `apps/admin/src/songs/use-song-catalog-runtime.ts`
- Modify: `apps/admin/src/songs/types.ts`
- Modify: `apps/admin/src/i18n.tsx`
- Modify or delete: `apps/admin/src/imports/*`
- Modify: `apps/admin/src/test/song-catalog.test.tsx`
- Modify: `apps/admin/src/test/song-catalog-runtime.test.tsx`
- Modify: `apps/admin/src/test/import-workbench.test.tsx`

**Step 1: Write failing Admin tests**

Assert formal catalog controls are gone:

```ts
expect(screen.queryByText(/Formal song/)).toBeNull();
expect(screen.queryByText(/正式曲库/)).toBeNull();
expect(screen.getByText(/NAS 曲库/)).toBeTruthy();
```

Assert Admin no longer calls:

```text
/admin/catalog/songs
/admin/imports
```

**Step 2: Remove or hide old import/catalog screens**

Keep NAS diagnostics from existing KTV index page. Rename UI labels to NAS.

**Step 3: Keep API client only for live routes**

Remove client methods calling retired endpoints.

**Step 4: Run tests**

Run:

```bash
pnpm -F @home-ktv/admin test
pnpm -F @home-ktv/admin typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/admin/src
git commit -m "refactor(admin): make NAS diagnostics the song library view"
```

---

### Task 14: Update Cover Docs, Deployment Docs, And Runbooks

**Files:**
- Modify: `docs/runbooks/song-cover-fetching.md`
- Modify: `docs/plans/2026-05-28-song-cover-cache-design.md`
- Modify: `deploy/docker/README.md`
- Modify: `deploy/docker/ktv.sh` if cover commands need renamed defaults
- Create or modify: `docs/runbooks/nas-online-catalog-migration.md`
- Modify: `README.md` if old formal catalog is documented

**Step 1: Update cover docs**

Replace:

```text
ktv-index
formal
```

with:

```text
nas
online
```

where describing runtime source kinds.

Keep explanatory notes if needed:

```text
The physical NAS index tables are still named ktv_*.
```

**Step 2: Add migration runbook**

Create `docs/runbooks/nas-online-catalog-migration.md` with:

- backup command
- pre-migration SQL checks
- deploy sequence
- post-migration SQL validation
- smoke test URLs
- restore-based rollback

**Step 3: Run docs grep**

Run:

```bash
rg -n "songs/assets|source_records|indexedAssetId|ktv-index|formal catalog|available-songs" README.md docs deploy apps/api/src apps/controller/src apps/admin/src
```

Expected: Any remaining matches are intentional historical notes or admin diagnostics.

**Step 4: Commit**

```bash
git add docs/runbooks/song-cover-fetching.md docs/plans/2026-05-28-song-cover-cache-design.md docs/runbooks/nas-online-catalog-migration.md deploy/docker/README.md deploy/docker/ktv.sh README.md
git commit -m "docs: document NAS catalog migration"
```

---

### Task 15: Full Verification And Deployment Readiness

**Files:**
- No implementation files expected unless verification exposes bugs.

**Step 1: Run package checks**

Run:

```bash
pnpm -F @home-ktv/api typecheck
pnpm -F @home-ktv/api test
pnpm -F @home-ktv/controller typecheck
pnpm -F @home-ktv/controller test
pnpm -F @home-ktv/tv-web typecheck
pnpm -F @home-ktv/tv-web test
pnpm -F @home-ktv/admin typecheck
pnpm -F @home-ktv/admin test
```

Expected: PASS.

**Step 2: Run Android tests**

Run:

```bash
cd clients/android-tv && ./gradlew testDebugUnitTest
```

Expected: PASS.

**Step 3: Run workspace build**

Run:

```bash
pnpm build
```

Expected: PASS.

**Step 4: Run migration dry checks against a database copy**

Use a restored copy of production DB if available. Do not run destructive migration first against production.

Run:

```bash
pnpm db:migrate
```

Then post-migration SQL from `docs/runbooks/nas-online-catalog-migration.md`.

Expected:

- `songs`, `assets`, `source_records` are gone.
- active queue entries are mapped or explicitly failed.
- discovery returns NAS songs.
- media route streams a known NAS asset.

**Step 5: Run deploy smoke locally or staging**

Run:

```bash
pnpm deploy:doctor
curl -sS "$API/health"
curl -sS "$API/rooms/living-room/songs/discovery?limit=5" | jq .
curl -I -H 'Range: bytes=0-1023' "$API/media/nas/<known-asset-id>"
```

Expected: health OK, discovery includes `source: "nas"`, media range returns `206`.

**Step 6: Commit fixes if any**

If verification required bug fixes:

```bash
git add <changed-files>
git commit -m "fix: stabilize NAS catalog refactor"
```

**Step 7: Final review**

Run:

```bash
git status --short
git log --oneline -n 12
```

Expected: clean or only intentionally unrelated local files remain.

---

## Deployment Checklist

1. Stop services.
2. Backup production DB.
3. Deploy new code.
4. Run migrations.
5. Restart services.
6. Run doctor.
7. Run post-migration SQL validation.
8. Open Controller with token.
9. Add a recommended NAS song.
10. Confirm queue badge updates immediately.
11. Confirm Control tab shows the queued song.
12. Confirm TV receives playback target and plays.
13. Confirm player ended/failed telemetry does not reject due to missing source identity.

---

## Rollback Checklist

1. Stop services.
2. Restore pre-migration DB backup.
3. Deploy previous code commit.
4. Restart services.
5. Run doctor.
6. Verify Controller, TV presence, queue, and playback.

Do not attempt to reconstruct `songs/assets` from NAS tables as a down migration.

