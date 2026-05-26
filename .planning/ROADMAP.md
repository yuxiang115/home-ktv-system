# Roadmap: 家庭包厢式 KTV 系统

## Milestones

- [x] **v1.0 MVP** - 单房间家庭 KTV 可唱闭环，Phases 1-5，shipped 2026-05-08. Archive: `.planning/milestones/v1.0-ROADMAP.md`
- [x] **v1.1 Polish** - TV 播放体验、产品化 UI、代码结构与逻辑打磨，Phases 6-11，shipped 2026-05-10. Archive: `.planning/milestones/v1.1-ROADMAP.md`
- [x] **v1.2 真实 MV 歌库** - 真实 MKV/MPG MV 文件接入，Phases 12-17，shipped 2026-05-14. Archive: `.planning/milestones/v1.2-ROADMAP.md`
- [x] **v1.3 真实场景接入与 Android TV 基线** - 真实索引搜索、队列同步、真实 NAS 播放验证和 Android TV/libVLC 技术路线收口，Phases 18-19 + direct implementation，converged 2026-05-26. Archive: `.planning/milestones/v1.3-ROADMAP.md`
- [ ] **v1.4 Android TV 产品化与流程简化** - 正式电视端、部署、诊断、真实歌库运维和代码/流程简化，Phases 20-26

## Overview

v1.4 的目标是把已经跑通的真实歌库 + Android TV 播放链路产品化。当前主链路已经可以用手机搜索真实 `ktv_*` 索引歌曲、点歌、进入队列，并由 Android TV + libVLC 播放 NAS 上的 MKV/MPG MV；用户也已经验证了 30 首随机样本大多可播放和切换音轨。

本里程碑不继续扩张产品边界，而是按真实使用顺序收口：先冻结当前可用基线，再完善 Android TV 配置、APK 发布、异常诊断、真实歌库运维和部署 smoke。中间安排一个独立的“代码和流程简化”章节，专门清理探索期留下的旧接口、旧流程和重复状态。

Explicitly out of scope for this roadmap: multi-room, accounts, scoring, realtime microphone DSP, mandatory server-side transcoding, large CMS features, and online provider acquisition/downloads.

## Current Milestone: v1.4 Android TV 产品化与流程简化

**Goal:** 让 HomeKTV 可以按真实家庭电视使用方式部署、启动、扫码、点歌、播放、切换、诊断和维护，并通过一次有证据的代码/流程简化降低后续维护成本。

**Phase Numbering:**
- v1.0 completed Phases 1-5.
- v1.1 completed Phases 6-11.
- v1.2 completed Phases 12-17.
- v1.3 completed/converged Phases 18-19 and direct Android TV baseline work.
- v1.4 continues with Phases 20-26.
- Decimal phases remain reserved for urgent insertions.

## Phases

- [ ] **Phase 20: Android TV Baseline UAT and Current Flow Freeze** - Freeze the current real playback baseline before further productization.
- [ ] **Phase 21: Android TV Startup Configuration and Persistence** - Make Android TV remember API/room/device configuration and recover without adb-only startup.
- [ ] **Phase 22: APK Release, Signing, and Install Workflow** - Provide repeatable debug/release APK build, signing, install, and rollback instructions.
- [ ] **Phase 23: Playback Resilience and Diagnostics** - Harden backend restart, network loss, NAS unreadable, playback failure, and track-switch failure visibility.
- [ ] **Phase 24: Code and Flow Simplification Audit** - Audit and simplify legacy interfaces, old media assumptions, redundant state, and non-core flows.
- [ ] **Phase 25: Admin Real Library Operations** - Improve Songs diagnostics for real indexed/NAS library operations without turning Admin into a CMS.
- [ ] **Phase 26: Production Deployment Smoke and Milestone Hardening** - Provide real-mode startup, logs, health checks, smoke scripts, UAT evidence, and audit readiness.

## Phase Details

### Phase 20: Android TV Baseline UAT and Current Flow Freeze

**Goal**: Establish the current real Android TV playback path as the regression baseline.
**Depends on**: v1.3 convergence
**Requirements**: BASE-01, BASE-02, BASE-03
**Success Criteria** (what must be TRUE):
  1. A manual UAT checklist covers QR entry, real search, queue, playback, skip, promote, delete, original/accompaniment switch, volume, and controller re-entry.
  2. The current verification command set is documented for API, Mobile, and Android TV.
  3. Known browser autoplay and Web TV limitations are explicitly separated from Android TV product behavior.
**Plans**: 2 plans
Plans:
- [ ] 20-01-PLAN.md - Baseline UAT checklist and deployment verification commands
- [ ] 20-02-PLAN.md - Current flow notes and known limitation register

### Phase 21: Android TV Startup Configuration and Persistence

**Goal**: Android TV can be launched like a product instead of depending on adb parameters every time.
**Depends on**: Phase 20
**Requirements**: ATV-01, ATV-02, ATV-03, ATV-04
**Success Criteria** (what must be TRUE):
  1. Android TV persists `apiBaseUrl`, `room`, and `deviceName` after a parameterized launch.
  2. Normal launch without adb parameters restores saved configuration.
  3. First launch without configuration shows a clear Chinese setup/connection state.
  4. API unreachable or network-lost states are visible on the TV without exposing noisy debug text.
**Plans**: 3 plans
Plans:
- [ ] 21-01-PLAN.md - Android TV config model and persistence tests
- [ ] 21-02-PLAN.md - No-parameter launch and setup state UI
- [ ] 21-03-PLAN.md - Network/API unreachable states and documentation
**UI hint**: yes

### Phase 22: APK Release, Signing, and Install Workflow

**Goal**: The Android TV app has a repeatable install/update path for real television testing.
**Depends on**: Phase 21
**Requirements**: APK-01, APK-02, APK-03, APK-04
**Success Criteria** (what must be TRUE):
  1. Debug and release APK build outputs are documented.
  2. Release signing uses local-only keystore configuration and does not commit secrets.
  3. Install, update, clear-data, launch, and rollback commands are documented.
  4. README explains how this Android TV app relates to the Web TV debug client.
**Plans**: 2 plans
Plans:
- [ ] 22-01-PLAN.md - Android TV release build and signing setup
- [ ] 22-02-PLAN.md - TV install/update/runbook documentation

### Phase 23: Playback Resilience and Diagnostics

**Goal**: Real playback failures are visible, recoverable, and diagnosable across Android TV, Mobile, Admin, and API logs.
**Depends on**: Phase 22
**Requirements**: RES-01, RES-02, RES-03, RES-04, RES-05
**Success Criteria** (what must be TRUE):
  1. Backend restart and TV reconnect do not leave Mobile/Admin in stale offline/online states.
  2. NAS unreadable and asset stream failures surface actionable Chinese messages.
  3. Track-switch failures keep current playback stable and expose raw evidence for diagnosis.
  4. Android TV reports enough playback diagnostics to map failures to current song/asset/url.
  5. Controller re-entry after phone browser close restores room state without manual refresh.
**Plans**: 4 plans
Plans:
- [ ] 23-01-PLAN.md - Reconnect and online-state hardening
- [ ] 23-02-PLAN.md - NAS/stream/playback failure surfaces
- [ ] 23-03-PLAN.md - Track-switch diagnostics and rollback evidence
- [ ] 23-04-PLAN.md - Controller re-entry and realtime refresh regression coverage
**UI hint**: yes

### Phase 24: Code and Flow Simplification Audit

**Goal**: Remove or downgrade interfaces and flows that real usage no longer needs, with proof before each deletion.
**Depends on**: Phase 23
**Requirements**: SIMP-01, SIMP-02, SIMP-03, SIMP-04, SIMP-05
**Success Criteria** (what must be TRUE):
  1. Audit identifies legacy Web TV assumptions, old dual-asset switch paths, redundant snapshot/control fields, online supplement scope, and deployment env duplication.
  2. Each candidate is classified as delete, keep, debug-only, or observe-later.
  3. Deletions are small-batch and covered by targeted tests or manual UAT evidence.
  4. Public protocol or database contract removals include compatibility notes.
  5. README/deployment docs no longer present obsolete flows as primary usage.
**Plans**: 4 plans
Plans:
- [ ] 24-01-PLAN.md - Simplification audit inventory and dependency evidence
- [ ] 24-02-PLAN.md - Web TV/debug path and deployment profile simplification
- [ ] 24-03-PLAN.md - Playback/control protocol simplification
- [ ] 24-04-PLAN.md - Online supplement and legacy catalog flow scope cleanup

### Phase 25: Admin Real Library Operations

**Goal**: Admin helps operate the real indexed NAS library without becoming a broad CMS.
**Depends on**: Phase 24
**Requirements**: OPS-01, OPS-02, OPS-03, OPS-04
**Success Criteria** (what must be TRUE):
  1. Songs diagnostics can inspect real indexed source identity, file path, file readability, and canonical sync status.
  2. Operators can recheck a single song/asset and run bounded random sample checks.
  3. Audio track count and inferred/reviewed original/accompaniment role evidence are visible.
  4. Admin copy stays concise and operational; detailed raw evidence remains behind diagnostics.
**Plans**: 3 plans
Plans:
- [ ] 25-01-PLAN.md - Real indexed song diagnostics expansion
- [ ] 25-02-PLAN.md - Single asset recheck and bounded sample check
- [ ] 25-03-PLAN.md - Track evidence display and Admin regression coverage
**UI hint**: yes

### Phase 26: Production Deployment Smoke and Milestone Hardening

**Goal**: Real-mode deployment is repeatable, observable, and ready for milestone audit.
**Depends on**: Phase 25
**Requirements**: DEPLOY-01, DEPLOY-02, DEPLOY-03, DEPLOY-04, VERIFY-01, VERIFY-02
**Success Criteria** (what must be TRUE):
  1. One real-mode command/profile starts API, Admin, Mobile, and logs with consistent env.
  2. A smoke command checks PostgreSQL, `ktv_*` counts, NAS sample readability, API health, search, queue-time sync, asset stream, and current TV snapshot.
  3. Android TV install/launch instructions include LAN API URL and configuration persistence behavior.
  4. Human UAT instructions are short enough to execute without asking what to verify next.
  5. Milestone audit can map all v1.4 requirements to implementation and verification evidence.
**Plans**: 3 plans
Plans:
- [ ] 26-01-PLAN.md - Real-mode deployment profile and env contract
- [ ] 26-02-PLAN.md - Real-library smoke script and logs workflow
- [ ] 26-03-PLAN.md - UAT guide, audit evidence, and milestone closeout

## Progress

**Execution Order:**
Phases execute in numeric order: 20 -> 21 -> 22 -> 23 -> 24 -> 25 -> 26

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 20. Android TV Baseline UAT and Current Flow Freeze | 0/2 | Ready | — |
| 21. Android TV Startup Configuration and Persistence | 0/3 | Blocked on Phase 20 | — |
| 22. APK Release, Signing, and Install Workflow | 0/2 | Blocked on Phase 21 | — |
| 23. Playback Resilience and Diagnostics | 0/4 | Blocked on Phase 22 | — |
| 24. Code and Flow Simplification Audit | 0/4 | Blocked on Phase 23 | — |
| 25. Admin Real Library Operations | 0/3 | Blocked on Phase 24 | — |
| 26. Production Deployment Smoke and Milestone Hardening | 0/3 | Blocked on Phase 25 | — |

## Archived Phase Details

- v1.0 phases: `.planning/milestones/v1.0-phases/`
- v1.1 phases: `.planning/milestones/v1.1-phases/`
- v1.2 phases: `.planning/milestones/v1.2-phases/`
- v1.3 active phase artifacts: `.planning/phases/18-ktv-index-read-model-and-diagnostics/`, `.planning/phases/19-search-and-queue-time-catalog-sync/`
