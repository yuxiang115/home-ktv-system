---
gsd_state_version: 1.0
milestone: v1.4
milestone_name: Android TV 产品化与流程简化
status: planning
stopped_at: Created v1.4 roadmap
last_updated: "2026-05-26T21:40:00+08:00"
last_activity: 2026-05-26
progress:
  total_phases: 7
  completed_phases: 0
  total_plans: 21
  completed_plans: 0
  percent: 0
---

# Project State

## Project Reference

See: `.planning/PROJECT.md`

**Core value:** 在家庭单电视场景下，让用户用手机完成全部点歌与控制，并稳定地把歌唱起来。
**Current focus:** Phase 20 — Android TV baseline UAT and current flow freeze

## Current Position

Milestone: v1.4 Android TV 产品化与流程简化
Phase: 20 (android-tv-baseline-uat-and-current-flow-freeze) — READY
Plan: 0 of 2
Status: Ready to plan/execute Phase 20
Last activity: 2026-05-26

Progress: [----------] 0%

## Performance Metrics

**Velocity:**

- Total plans completed before v1.4: 62+ tracked GSD plans plus direct Android TV productization commits
- Average duration: See milestone archives
- Total execution time: See milestone archives

## Accumulated Context

### Decisions

- [Milestone v1.4]: Android TV + libVLC is now the official TV playback target; Web TV remains a debug/development client.
- [Milestone v1.4]: Real MV playback uses one media file with one active audio track at a time; original/accompaniment switching changes libVLC audio track, not separate media volumes.
- [Milestone v1.4]: Volume is a single room-level playback volume, not separate original/accompaniment volumes.
- [Milestone v1.4]: Code and flow simplification must be evidence-led: audit first, classify candidates, then remove or downgrade in small batches.
- [Milestone v1.4]: Productization priority is deployment, Android TV startup/persistence, resilience, diagnostics, and real-library operations before new feature expansion.
- [Milestone v1.3]: Search may read `ktv_*` directly, but queue/playback should continue using canonical `songs/assets` by syncing selected indexed assets at queue time.
- [Milestone v1.3]: Real deployment must validate PostgreSQL index health, NAS path mapping, file readability, API streaming, and TV/Mobile runtime separately.
- [Milestone v1.2]: Real MV library work uses one MKV/MPG/MPEG file as one song, with optional sibling cover image and `song.json` metadata.
- [Milestone v1.2]: MediaInfo is the primary metadata source; filename and sibling `song.json` fill gaps before Admin review.

### Pending Todos

- Create Phase 20 plans and baseline UAT checklist.
- Run current verification commands after the latest volume-control work is deployed.
- Keep unrelated dirty/untracked files out of commits unless explicitly scoped.

### Blockers/Concerns

- Current planning files were stale after direct Android TV implementation; v1.4 starts by restoring planning/runtime alignment.
- Some v1.3 Phase 20-22 ideas are still relevant, but they are now folded into v1.4 Phase 23/26 because Android TV became the official playback path.
- Simplification must not remove Web TV debug usefulness before Android TV deployment and diagnostics are stable.

## Session Continuity

Last session: 2026-05-26
Stopped at: Created v1.4 roadmap
Resume file: None
