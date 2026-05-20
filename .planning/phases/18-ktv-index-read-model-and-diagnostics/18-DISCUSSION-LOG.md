# Phase 18: KTV Index Read Model and Diagnostics - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-20
**Phase:** 18-ktv-index-read-model-and-diagnostics
**Areas discussed:** diagnostics placement, Mobile search exposure, result grouping, diagnostic health presentation, NAS readability sampling, queueing scope boundary

---

## Diagnostics Placement

| Option | Description | Selected |
|--------|-------------|----------|
| Admin new KTV Index tab | Add a new top-level Admin tab for real index diagnostics. | |
| Existing Songs area | Keep diagnostics in the existing Songs/catalog area. | ✓ |
| API only | Build only read-only API diagnostics in Phase 18. | |

**User's choice:** Keep diagnostics in Songs.
**Notes:** User expected this to be in Songs already and asked to maintain that placement.

---

## Mobile Search Exposure

| Option | Description | Selected |
|--------|-------------|----------|
| Admin-only preview | Show indexed search only in Admin diagnostics for Phase 18. | |
| Extend Mobile search | Extend existing Mobile search with KTV indexed results. | ✓ |
| API only | Add low-level `/ktv/search` style API only. | |

**User's choice:** Directly extend Mobile search.
**Notes:** User wants this to become actually usable from the phone. Phase 18 context records that Mobile search should expose indexed results, while queue-time sync remains Phase 19 unless roadmap scope is revised.

---

## Search Result Grouping

| Option | Description | Selected |
|--------|-------------|----------|
| Song grouped with versions | Group by song and show expandable/nested versions/assets. | ✓ |
| One asset per row | Show every indexed file as its own search result. | |
| Song only | Hide asset/version details for now. | |

**User's choice:** Song-grouped results with multiple versions.
**Notes:** Mobile should avoid low-level file path detail; Admin may show deeper version/path evidence.

---

## Diagnostic Health Presentation

| Option | Description | Selected |
|--------|-------------|----------|
| healthy/degraded/blocked | Interpret raw metrics into system health states. | |
| Raw metrics only | Show original metrics without health judgment. | ✓ |
| ok/warning/error | Use conventional traffic-light status categories. | |

**User's choice:** Show raw metrics, no health-status judgment.
**Notes:** Planner may still group and label metrics, but should not collapse them into a single health score/status in Phase 18.

---

## NAS Readability Sampling

| Option | Description | Selected |
|--------|-------------|----------|
| Random sample | Randomly sample active indexed files for read checks. | ✓ |
| No read check | Leave all file-read validation for Phase 20. | |
| Full scan | Check every active asset path. | |

**User's choice:** Random sampling check for NAS readability.
**Notes:** Sampling must be lightweight, bounded, read-only, and timeout-safe. It should not scan all 34k+ active assets.

---

## Scope Boundary

| Option | Description | Selected |
|--------|-------------|----------|
| Keep Phase 18 read-only | Prepare indexed search/diagnostics now; queueable sync in Phase 19. | ✓ |
| Merge Phase 19 into Phase 18 | Revise roadmap before planning so Phase 18 includes queue-time sync. | |

**User's choice:** User requested practical usability from Mobile search. The workflow scope boundary keeps actual queue-time catalog sync in Phase 19 unless the roadmap is explicitly revised.
**Notes:** This is the only conflict between user intent and current roadmap. Context captures the intent and flags Phase 19 as the immediate follow-up.

---

## the agent's Discretion

- Exact API route names for Admin diagnostics.
- Exact Admin Songs layout for index diagnostics.
- Exact NAS sample size/timeouts/randomization strategy.
- Exact indexed search response field names, as long as Phase 19 can resolve selected indexed assets server-side.

## Deferred Ideas

- Queueing indexed Mobile search results through canonical catalog sync — Phase 19 unless roadmap is revised.
- Media path streaming and playback verification — Phase 20.
- Real deployment profile — Phase 21.
