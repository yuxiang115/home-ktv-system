# KTV Sample Index Verification Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a repeatable 200-song sample import that records parsed title, artist, category, and path, then use it to measure filename parsing accuracy against the KTV library.

**Architecture:** A small ingest helper will collect media paths from the NAS over SSH, sample 200 unique files, derive metadata with the existing real-MV filename parser plus folder fallback, and write the results into a dedicated PostgreSQL sample table. A CLI wrapper will also emit a human-readable report so the parsing quality is easy to inspect and rerun.

**Tech Stack:** TypeScript, Vitest, `pg`, `tsx`, SSH shell commands, PostgreSQL.

---

### Task 1: Add helper coverage for sample selection and metadata inference

**Files:**
- Create: `apps/api/src/modules/ingest/ktv-sample-index.ts`
- Create: `apps/api/src/test/ktv-sample-index.test.ts`

**Step 1: Write the failing test**

Cover one filename-based parse case, one folder-fallback case, and one unique sampling case.

**Step 2: Run test to verify it fails**

Run: `pnpm -F @home-ktv/api test -- src/test/ktv-sample-index.test.ts`
Expected: fail because the module does not exist yet.

**Step 3: Write minimal implementation**

Implement only the helper functions needed by the tests.

**Step 4: Run test to verify it passes**

Run: `pnpm -F @home-ktv/api test -- src/test/ktv-sample-index.test.ts`
Expected: pass.

### Task 2: Add a CLI to collect 200 random library files and persist sample rows

**Files:**
- Create: `apps/api/src/scripts/ktv-sample-index.ts`

**Step 1: Write the failing test**

Add a small integration-style test for the CLI option parsing or the run-row payload builder if needed.

**Step 2: Run test to verify it fails**

Run: `pnpm -F @home-ktv/api test -- src/test/ktv-sample-index.test.ts`
Expected: fail until the CLI wiring exists.

**Step 3: Write minimal implementation**

Implement SSH file discovery, sampling, PostgreSQL table creation, and idempotent inserts.

**Step 4: Run test to verify it passes**

Run: `pnpm -F @home-ktv/api test -- src/test/ktv-sample-index.test.ts`
Expected: pass.

### Task 3: Execute the 200-song sample and review the report

**Files:**
- Create: `docs/reports/ktv-sample-index-*.md`

**Step 1: Run the CLI against `/mnt/nas/KTV歌曲`**

Run the script with SSH host `lxc-nas` and the local PostgreSQL instance.

**Step 2: Inspect the generated report**

Check how many rows parsed cleanly, how many need manual review, and which filename patterns were ambiguous.

**Step 3: Refine parsing if needed**

Only adjust parsing rules if the sample shows a repeated, high-frequency failure mode.
