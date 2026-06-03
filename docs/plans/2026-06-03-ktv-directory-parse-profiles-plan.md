# KTV Directory Parse Profiles Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make each known first-level KTV directory use an explicit filename parsing profile so newly added NAS sources index with correct artist, title, and category values.

**Architecture:** Keep parsing logic centralized in `ktv-sample-index.ts`. Replace the current small root-folder whitelist with a first-level directory profile map and two strict dash-tail parser variants: one normal and one that preserves trailing title parentheses for variety-show titles.

**Tech Stack:** TypeScript, Node.js, Vitest

---

### Task 1: Lock the desired parsing behavior with minimal tests

**Files:**
- Modify: `apps/api/src/test/ktv-sample-index.test.ts`
- Reference: `apps/api/src/modules/ingest/ktv-sample-index.ts`

**Step 1: Write the failing tests**

Add minimal tests for:

- `流行精选/冷酷-握不住手中沙-国语-流行.mkv` -> `title=握不住手中沙`, `artistName=冷酷`, `category=流行`, `parseStrategy=filename`
- `1080P全高清MPG2026年更新（更新中）/.../F4-第一时间 (Live)[1080P]-国语-合唱.mpg` -> `title=第一时间 (Live)[1080P]`, `artistName=F4`, `category=合唱`, `parseStrategy=filename`
- `综合专辑 9300首1.4T/.../康树龙-魔鬼中的天使(2018中国好声音)-国语-流行.mpg` -> title keeps `魔鬼中的天使(2018中国好声音)`

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm -F @home-ktv/api test -- ktv-sample-index
```

Expected:

- New assertions fail because these directories currently fall back to `path` parsing.

**Step 3: Commit**

```bash
git add apps/api/src/test/ktv-sample-index.test.ts
git commit -m "test: lock KTV directory parse profiles"
```

### Task 2: Implement directory profile mapping and parser variants

**Files:**
- Modify: `apps/api/src/modules/ingest/ktv-sample-index.ts`
- Test: `apps/api/src/test/ktv-sample-index.test.ts`

**Step 1: Write minimal implementation**

Implement:

- a first-level directory to profile map
- `strict_dash_tail` parser
- `strict_dash_tail_keep_trailing_parens` parser
- a small option on the existing strict dash-tail parser that controls whether trailing title parentheses are stripped

Do not introduce runtime config, JSON config, or database-backed parse profiles.

**Step 2: Run test to verify it passes**

Run:

```bash
pnpm -F @home-ktv/api test -- ktv-sample-index
```

Expected:

- `ktv-sample-index` tests pass

**Step 3: Refactor**

- Keep helpers small and local to `ktv-sample-index.ts`
- Avoid changing unrelated ingest or indexing code

**Step 4: Run test again**

Run:

```bash
pnpm -F @home-ktv/api test -- ktv-sample-index
```

Expected:

- Still all green

**Step 5: Commit**

```bash
git add apps/api/src/modules/ingest/ktv-sample-index.ts apps/api/src/test/ktv-sample-index.test.ts
git commit -m "feat: add KTV directory parse profiles"
```

### Task 3: Verify no obvious regressions in the full index helpers

**Files:**
- Test: `apps/api/src/test/ktv-full-index.test.ts`
- Test: `apps/api/src/test/ktv-sample-index.test.ts`

**Step 1: Run targeted verification**

Run:

```bash
pnpm -F @home-ktv/api test -- ktv-sample-index ktv-full-index
```

Expected:

- Both suites pass

**Step 2: Commit**

```bash
git add apps/api/src/modules/ingest/ktv-sample-index.ts apps/api/src/test/ktv-sample-index.test.ts
git commit -m "test: verify KTV parse profile coverage"
```
