# Merge Music Scores Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a standalone Python tool that merges hot-song, chart-score, and playlist-score CSV outputs into one deduplicated score table.

**Architecture:** Keep the tool self-contained under `scripts/tools/`. Reuse the same normalization logic already used by the chart and playlist Python scripts so cross-script dedupe stays consistent. Read CSVs from either files or run directories, merge component scores by normalized song identity, then emit one merged CSV plus a small report JSON.

**Tech Stack:** Python 3 standard library, `csv`, `json`, `re`, `html`, `unicodedata`, `pathlib`, `unittest`

---

### Task 1: Add failing tests for CLI, normalization, and merge rules

**Files:**
- Create: `scripts/tools/merge_music_scores_test.py`
- Create: `scripts/tools/merge_music_scores.py`

**Step 1: Write the failing test**

Add tests for:

- CLI defaults
- input directory resolution
- normalized identity
- score merge across hot/chart/playlist
- duplicate collapse inside one source

**Step 2: Run test to verify it fails**

Run: `python3 scripts/tools/merge_music_scores_test.py`
Expected: FAIL because the script does not exist yet.

**Step 3: Write minimal implementation**

Implement:

- `parse_args`
- CSV row parsing helpers
- normalization helpers
- source merge helpers

**Step 4: Run test to verify it passes**

Run: `python3 scripts/tools/merge_music_scores_test.py`
Expected: PASS for the merge logic tests.

### Task 2: Add failing test for local output writing

**Files:**
- Modify: `scripts/tools/merge_music_scores_test.py`
- Modify: `scripts/tools/merge_music_scores.py`

**Step 1: Write the failing test**

Add an end-to-end local merge test that:

- writes three tiny input CSVs
- runs the merge flow
- verifies `merged-songs.csv` and `merge-report.json`

**Step 2: Run test to verify it fails**

Run: `python3 scripts/tools/merge_music_scores_test.py`
Expected: FAIL on missing output writer or merge runner pieces.

**Step 3: Write minimal implementation**

Implement:

- input path resolution
- merge runner
- CSV writer
- report writer

**Step 4: Run test to verify it passes**

Run: `python3 scripts/tools/merge_music_scores_test.py`
Expected: PASS.

### Task 3: Document usage and verify with fresh evidence

**Files:**
- Modify: `scripts/tools/README.md`

**Step 1: Run focused tests**

Run: `python3 scripts/tools/merge_music_scores_test.py`
Expected: PASS.

**Step 2: Run a local smoke using previous outputs**

Run: `python3 scripts/tools/merge_music_scores.py merge --hot-input <dir> --chart-input <dir> --playlist-input <dir> --output <dir>`
Expected: merged CSV and report written successfully.

**Step 3: Update runbook text**

Document:

- accepted input forms
- merge rule
- output files
- main command
