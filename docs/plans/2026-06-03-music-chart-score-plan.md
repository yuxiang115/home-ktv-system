# Music Chart Score Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a standalone Python tool that collects all charts from Chinese mainstream music platforms and outputs a merged `+10 per chart appearance` score table.

**Architecture:** Keep the tool self-contained under `scripts/tools/`. Implement platform discovery and chart collection as separate functions, then normalize and aggregate into a CSV report. Prefer standard-library HTTP and HTML parsing so the script can run in the existing deployment environment without extra Python packages.

**Tech Stack:** Python 3 standard library, `urllib`, `json`, `csv`, `re`, `html`, `concurrent.futures`, `unittest`

---

### Task 1: Add failing tests for CLI and aggregation

**Files:**
- Create: `scripts/tools/fetch_chart_scores_test.py`
- Create: `scripts/tools/fetch_chart_scores.py`

**Step 1: Write the failing test**

Add tests for:

- CLI defaults
- score aggregation with `+10` per chart hit
- dedupe inside one chart
- normalization merging noisy variants

**Step 2: Run test to verify it fails**

Run: `python3 scripts/tools/fetch_chart_scores_test.py`

Expected: FAIL because the new script does not exist yet.

**Step 3: Write minimal implementation**

Add script skeleton:

- `parse_args`
- aggregation helpers
- normalization helpers

**Step 4: Run test to verify it passes**

Run: `python3 scripts/tools/fetch_chart_scores_test.py`

Expected: PASS for the first aggregation-focused tests.

### Task 2: Add failing parser tests for platform discovery and chart rows

**Files:**
- Modify: `scripts/tools/fetch_chart_scores_test.py`
- Modify: `scripts/tools/fetch_chart_scores.py`

**Step 1: Write the failing test**

Add parser tests for:

- NetEase toplist discovery response
- QQ `window.__INITIAL_DATA__` discovery
- Kugou index and page parsing
- Kuwo index and detail parsing
- Migu rank index and rank info parsing

**Step 2: Run test to verify it fails**

Run: `python3 scripts/tools/fetch_chart_scores_test.py`

Expected: FAIL on missing parser functions.

**Step 3: Write minimal implementation**

Add parser functions for each platform using small fixtures and standard-library parsing.

**Step 4: Run test to verify it passes**

Run: `python3 scripts/tools/fetch_chart_scores_test.py`

Expected: PASS for parser coverage.

### Task 3: Implement network collection and reporting

**Files:**
- Modify: `scripts/tools/fetch_chart_scores.py`
- Modify: `scripts/tools/README.md`

**Step 1: Write the failing test**

Add tests for:

- default output path resolution
- source report recording failures
- Migu header construction

**Step 2: Run test to verify it fails**

Run: `python3 scripts/tools/fetch_chart_scores_test.py`

Expected: FAIL on missing collection/report helpers.

**Step 3: Write minimal implementation**

Implement:

- HTTP helpers
- per-platform discovery and collection functions
- output writers for JSON and CSV
- `collect` command flow

**Step 4: Run test to verify it passes**

Run: `python3 scripts/tools/fetch_chart_scores_test.py`

Expected: PASS.

### Task 4: Run smoke verification and document usage

**Files:**
- Modify: `scripts/tools/README.md`

**Step 1: Run focused tests**

Run: `python3 scripts/tools/fetch_chart_scores_test.py`

Expected: PASS.

**Step 2: Run a local smoke collection**

Run: `python3 scripts/tools/fetch_chart_scores.py collect --platforms qq,kugou,kuwo,migu --output runtime/chart-scores/smoke`

Expected: output files created and non-empty report rows for reachable platforms.

**Step 3: Run NetEase smoke if local API is available**

Run: `python3 scripts/tools/fetch_chart_scores.py collect --platforms netease --netease-base-url http://127.0.0.1:4300 --output runtime/chart-scores/netease-smoke`

Expected: works when the local `NeteaseCloudMusicApiBackup` service is up; otherwise a clear source failure is recorded.

**Step 4: Update runbook text**

Document:

- supported platforms
- NetEase local API dependency
- output files
- main commands
