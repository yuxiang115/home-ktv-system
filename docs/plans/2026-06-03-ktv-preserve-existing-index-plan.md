# KTV Preserve Existing Index Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a safe `--preserve-existing` KTV indexing mode that inserts new NAS songs but never overwrites existing same-path metadata, tags, or probe results.

**Architecture:** Keep the existing `index:ktv` flow, but thread a `preserveExisting` flag from the CLI into the importer. Split conflict-update behavior into default mode and preserve-existing mode so same-path conflicts only refresh existence and filesystem metadata while leaving curated song fields untouched.

**Tech Stack:** TypeScript, Node.js, PostgreSQL SQL strings, Vitest

---

### Task 1: Lock safe same-path behavior in importer tests

**Files:**
- Modify: `apps/api/src/test/ktv-full-index.test.ts`
- Reference: `apps/api/src/modules/ingest/ktv-full-index.ts`

**Step 1: Write the failing test**

Add a test that calls `indexKtvAssetDrafts(..., { preserveExisting: true })` and asserts the generated upsert SQL:

- still uses `ON CONFLICT (file_path)`
- still clears `missing_at`
- still updates `last_seen_run_id`
- does **not** overwrite `style_tags`
- does **not** overwrite `technical_status` / `technical_metadata`
- does **not** overwrite title or artist fields

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm -F @home-ktv/api exec vitest run src/test/ktv-full-index.test.ts
```

Expected:

- New preserve-existing assertion fails because current SQL always overwrites metadata.

### Task 2: Lock CLI flag parsing and forwarding

**Files:**
- Create: `apps/api/src/test/ktv-full-index-cli.test.ts`
- Modify: `apps/api/src/scripts/ktv-full-index.ts`

**Step 1: Write the failing test**

Add CLI tests that assert:

- `--preserve-existing` parses to `preserveExisting: true`
- `runKtvFullIndexCli(...)` forwards `preserveExisting: true` into `indexKtvAssetDrafts`

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm -F @home-ktv/api exec vitest run src/test/ktv-full-index-cli.test.ts
```

Expected:

- Fails because the CLI does not expose the flag or testable functions yet.

### Task 3: Implement preserve-existing importer behavior

**Files:**
- Modify: `apps/api/src/modules/ingest/ktv-full-index.ts`
- Test: `apps/api/src/test/ktv-full-index.test.ts`

**Step 1: Write minimal implementation**

Implement:

- `preserveExisting?: boolean` on `IndexKtvAssetDraftsInput`
- preserve-existing conflict SQL that only updates safe filesystem/existence fields
- default path remains unchanged when the flag is absent

**Step 2: Run importer tests**

Run:

```bash
pnpm -F @home-ktv/api exec vitest run src/test/ktv-full-index.test.ts
```

Expected:

- Importer tests pass

### Task 4: Implement CLI flag and testable entrypoints

**Files:**
- Modify: `apps/api/src/scripts/ktv-full-index.ts`
- Test: `apps/api/src/test/ktv-full-index-cli.test.ts`

**Step 1: Write minimal implementation**

Refactor the script to export:

- `parseKtvFullIndexCliOptions(...)`
- `runKtvFullIndexCli(...)`

Add `--preserve-existing` and thread it into `indexKtvAssetDrafts`.

**Step 2: Run CLI tests**

Run:

```bash
pnpm -F @home-ktv/api exec vitest run src/test/ktv-full-index-cli.test.ts
```

Expected:

- CLI tests pass

### Task 5: Run targeted regression verification

**Files:**
- Test: `apps/api/src/test/ktv-full-index.test.ts`
- Test: `apps/api/src/test/ktv-full-index-cli.test.ts`
- Test: `apps/api/src/test/ktv-sample-index.test.ts`

**Step 1: Run verification**

Run:

```bash
pnpm -F @home-ktv/api exec vitest run src/test/ktv-full-index.test.ts src/test/ktv-full-index-cli.test.ts src/test/ktv-sample-index.test.ts
```

Expected:

- All targeted suites pass

### Task 6: Prepare the production-safe supplement command

**Files:**
- None

**Step 1: Form the command**

Prepare the exact production command:

```bash
pnpm -F @home-ktv/api index:ktv -- \
  --source-root /mnt/nas/KTV歌曲 \
  --database-url <server-db-url> \
  --preserve-existing
```

**Step 2: Only run after code and tests pass**

If the user wants immediate production supplementation, execute the command on the target server after confirming the real database URL/environment.
