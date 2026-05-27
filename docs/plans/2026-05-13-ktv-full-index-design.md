# KTV Full Index Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a durable, query-friendly KTV index from the full NAS library, with simple folder-aware filename parsing, normalized artist/song tables, and an incremental reindex path.

**Architecture:** The full index uses a dedicated PostgreSQL schema (`ktv_index_runs`, `ktv_artists`, `ktv_songs`, `ktv_song_artists`, `ktv_song_assets`) so it stays separate from the existing playback catalog. Files are discovered from `lxc-nas:/mnt/nas/KTV歌曲`, parsed by folder-specific filename rules, and upserted idempotently by `file_path`. Technical media metadata stays separate and is filled later from `ffprobe`, so filename parsing and media probing can evolve independently.

**Tech Stack:** PostgreSQL, TypeScript, `pg`, `tsx`, SSH shell commands, Vitest.

---

### Task 1: Define the index schema and parser contracts

**Files:**
- Modify: `apps/api/src/db/migrations/0008_ktv_full_index.sql`
- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/src/modules/ingest/ktv-sample-index.ts`
- Create: `apps/api/src/modules/ingest/ktv-full-index.ts`
- Create: `apps/api/src/test/ktv-sample-index.test.ts`
- Create: `apps/api/src/test/ktv-full-index.test.ts`

**Step 1: Write the failing tests**

Cover:
- folder-aware parsing
- multiple artist split
- normalized title and artist lookup keys
- asset path idempotency

**Step 2: Run test to verify it fails**

Run: `pnpm -F @home-ktv/api exec vitest run src/test/ktv-full-index.test.ts src/test/ktv-sample-index.test.ts`

**Step 3: Write minimal implementation**

Add the schema and parser helpers only.

**Step 4: Run test to verify it passes**

Run: `pnpm -F @home-ktv/api exec vitest run src/test/ktv-full-index.test.ts src/test/ktv-sample-index.test.ts`

### Task 2: Add the full indexing CLI

**Files:**
- Create: `apps/api/src/scripts/ktv-full-index.ts`
- Modify: `apps/api/package.json`

**Step 1: Write the failing test**

Add a CLI smoke test for option parsing or discovery conversion if needed.

**Step 2: Run test to verify it fails**

Run: `pnpm -F @home-ktv/api exec vitest run src/test/ktv-full-index.test.ts`

**Step 3: Write minimal implementation**

Implement SSH discovery, batching, PostgreSQL upserts, and run tracking.

**Step 4: Run test to verify it passes**

Run: `pnpm -F @home-ktv/api exec vitest run src/test/ktv-full-index.test.ts`

### Task 3: Validate against the NAS library

**Files:**
- Create or update: `docs/reports/ktv-sample-index-*.md`

**Step 1: Run the CLI in smoke mode**

Use `--limit 20` against `lxc-nas` and local PostgreSQL.

**Step 2: Run the full index**

Index the complete `/mnt/nas/KTV歌曲` tree.

**Step 3: Inspect counts**

Check `ktv_song_assets`, `ktv_songs`, `ktv_artists`, parse strategy counts, and low-confidence rows.

### Task 4: Write the docs

**Files:**
- Create: `docs/KTV-FULL-INDEX.md`
- Create: `docs/KTV-FULL-INDEX-API.md`

**Step 1: Document architecture and schema**

Explain tables, parsing rules, idempotency, and reindexing.

**Step 2: Document how to run and query**

Show the index command, sample SQL, and how to add new folder rules.
