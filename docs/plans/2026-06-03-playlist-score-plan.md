# Playlist Score Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a standalone Python tool that collects songs from playlist search results and direct playlist references, then outputs a merged playlist-based score table.

**Architecture:** Keep the tool self-contained under `scripts/`. Reuse the chart script's normalization and report shape, but implement playlist-specific discovery and fetch paths separately. Use only the Python standard library plus local `node` subprocess calls for Kuwo signing so the script runs in the existing environment without new Python package requirements.

**Tech Stack:** Python 3 standard library, `urllib`, `json`, `csv`, `re`, `html`, `subprocess`, `unittest`

---

### Task 1: Add failing tests for CLI, inputs, and aggregation

**Files:**
- Create: `scripts/fetch_playlist_scores_test.py`
- Create: `scripts/fetch_playlist_scores.py`

**Step 1: Write the failing test**

Add tests for:

- CLI defaults
- keyword parsing
- direct playlist parsing
- score aggregation with `+10` per playlist hit
- dedupe inside one playlist

**Step 2: Run test to verify it fails**

Run: `python3 scripts/fetch_playlist_scores_test.py`

Expected: FAIL because the new script does not exist yet.

**Step 3: Write minimal implementation**

Add script skeleton:

- `parse_args`
- input parsing helpers
- normalization helpers
- aggregation helpers

**Step 4: Run test to verify it passes**

Run: `python3 scripts/fetch_playlist_scores_test.py`

Expected: PASS for the first input and aggregation tests.

### Task 2: Add failing parser tests for per-platform playlist parsing

**Files:**
- Modify: `scripts/fetch_playlist_scores_test.py`
- Modify: `scripts/fetch_playlist_scores.py`

**Step 1: Write the failing test**

Add parser tests for:

- NetEase keyword playlist search response
- NetEase playlist track response
- Kuwo keyword playlist search response
- Kuwo playlist song response
- QQ direct playlist response
- Kugou direct playlist response

**Step 2: Run test to verify it fails**

Run: `python3 scripts/fetch_playlist_scores_test.py`

Expected: FAIL on missing parser functions.

**Step 3: Write minimal implementation**

Add parser functions for each platform using inline fixtures and standard-library parsing.

**Step 4: Run test to verify it passes**

Run: `python3 scripts/fetch_playlist_scores_test.py`

Expected: PASS for parser coverage.

### Task 3: Implement real collection flow and reporting

**Files:**
- Modify: `scripts/fetch_playlist_scores.py`
- Modify: `scripts/README.md`

**Step 1: Write the failing test**

Add tests for:

- playlist URL extraction
- source report contents
- output directory resolution
- request de-duplication behavior

**Step 2: Run test to verify it fails**

Run: `python3 scripts/fetch_playlist_scores_test.py`

Expected: FAIL on missing collection/report helpers.

**Step 3: Write minimal implementation**

Implement:

- keyword search collection for NetEase and Kuwo
- direct playlist collection for NetEase, QQ, Kugou, Kuwo
- Kuwo `reqId` and `Secret` generation via local node helper execution
- Kugou request signing
- output writers for JSON and CSV
- `collect` command flow

**Step 4: Run test to verify it passes**

Run: `python3 scripts/fetch_playlist_scores_test.py`

Expected: PASS.

### Task 4: Run smoke verification and document usage

**Files:**
- Modify: `scripts/README.md`

**Step 1: Run focused tests**

Run: `python3 scripts/fetch_playlist_scores_test.py`

Expected: PASS.

**Step 2: Run a keyword-search smoke**

Run: `python3 scripts/fetch_playlist_scores.py collect --keywords 周杰伦 --search-limit-per-keyword 5 --output runtime/playlist-scores/smoke-keyword`

Expected: output files created and non-empty playlist rows from reachable keyword-search platforms.

**Step 3: Run a direct-playlist smoke**

Run: `python3 scripts/fetch_playlist_scores.py collect --playlist-urls-file <sample-file> --output runtime/playlist-scores/smoke-direct`

Expected: output files created and direct playlist parsing works for reachable sample playlists.

**Step 4: Update runbook text**

Document:

- supported keyword-search platforms
- supported direct-playlist platforms
- NetEase local API dependency
- output files
- main commands
