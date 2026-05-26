# 家庭包厢式 KTV 系统

## What This Is

这是一个面向家庭客厅场景的单房间包厢式 KTV 系统。电视只负责全屏播放和入场展示，手机是唯一控制端，中心服务端统一管理点歌、队列、播放状态、真实歌库索引、媒体访问和运维诊断。

## Core Value

在家庭单电视场景下，让用户用手机完成全部点歌与控制，并稳定地把歌唱起来。

## Current State

系统已经具备：

- 手机扫码入场、控制会话恢复、多手机实时同步、点歌、删歌、顶歌、切歌、原唱/伴唱切换和单音量控制。
- 真实 KTV 索引接入：Mobile 搜索可以读取 `ktv_*` active assets，点歌时幂等同步到 canonical `songs/assets`，队列和播放继续复用现有状态机。
- 真实 MV 模型：一个 MKV/MPG/MPEG 文件是一首歌的一个 real-MV Asset，文件内音轨用于原声/伴奏切换。
- Android TV 正式端：`HomeKTV` 使用 libVLC 播放真实 NAS MV，支持二维码入场、播放状态上报、音轨切换和全屏自适应显示。
- Admin 和 Mobile 默认中文界面，Admin Songs 承载真实索引诊断和后台房间状态观察。
- 本地部署脚本、项目结构文档、Android TV 文档、热门歌曲抓取文档已开始产品化整理。

v1.0、v1.1、v1.2 已完成并归档。v1.3 从真实索引搜索和队列同步开始，随后通过真实电视端验证收敛到 Android TV + libVLC 作为正式播放路线。v1.4 当前目标是把这条真实链路产品化，并安排一次独立的代码和流程简化章节，清理探索期留下的不必要接口和流程。

Milestone archives:

- `.planning/milestones/v1.0-ROADMAP.md`
- `.planning/milestones/v1.0-REQUIREMENTS.md`
- `.planning/milestones/v1.0-MILESTONE-AUDIT.md`
- `.planning/milestones/v1.1-ROADMAP.md`
- `.planning/milestones/v1.1-REQUIREMENTS.md`
- `.planning/milestones/v1.1-MILESTONE-AUDIT.md`
- `.planning/milestones/v1.2-ROADMAP.md`
- `.planning/milestones/v1.2-REQUIREMENTS.md`
- `.planning/milestones/v1.2-MILESTONE-AUDIT.md`
- `.planning/milestones/v1.3-ROADMAP.md`
- `.planning/milestones/v1.3-REQUIREMENTS.md`

## Current Milestone: v1.4 Android TV 产品化与流程简化

**Goal:** 让 HomeKTV 可以按真实家庭电视使用方式部署、启动、扫码、点歌、播放、切换、诊断和维护，并通过一次有证据的代码/流程简化降低后续维护成本。

**Target features:**

- Android TV 启动配置持久化，不再每次依赖 adb 参数。
- APK debug/release 构建、签名、安装、更新和回滚流程清晰可重复。
- 真实播放异常能被定位：后端重启、网络异常、NAS 不可读、stream 失败、音轨切换失败。
- Admin Songs 提供真实歌库运维能力：索引来源、文件可读性、sync 状态、音轨数量、单曲重检和随机抽样。
- 真实模式部署和 smoke 验证可一键/单 profile 执行，各端日志可排查。
- 代码和流程简化以审计为先，移除或降级不再属于核心真实链路的旧接口、旧流程和重复状态。

**Status:** v1.4 roadmap created on 2026-05-26; ready for Phase 20.

## Requirements

### Validated

- v1.0 validated controlled media contracts, TV runtime binding, playback telemetry, switch rollback, reconnect behavior, and explicit player conflict handling.
- v1.0 validated local library scanning, import candidate review, strict formal catalog admission, `song.json` consistency validation, and admin maintenance for songs/resources.
- v1.0 validated QR entry, control-session restore, realtime room-state fanout, queue commands, current-song controls, and admin pairing-token refresh.
- v1.0 validated Chinese-first song search by title, artist, pinyin, initials, aliases, and search hints, plus version-aware mobile song selection.
- v1.0 validated local-first online supplement, cache-before-play boundaries, playback failure recovery, and admin recovery operations.
- v1.1 validated TV playback state readability, progress time display, first-play guidance, switch feedback, responsive TV layout, productized Chinese UI, paired Mobile visual coverage, and runtime boundaries.
- v1.2 validated real-MV catalog/player contracts, MKV/MPG/MPEG scanner candidates, same-stem covers and `song.json`, MediaInfo provenance, Admin review, single real-MV Asset admission, real-MV Mobile queueing, playback targets, and audio-track switch contracts.
- v1.3 validated read-only `ktv_*` index access, Admin Songs diagnostics, Mobile indexed search, idempotent queue-time catalog sync, canonical queue reuse, Android TV/libVLC playback direction, real sample playback, and single room-level volume.

### Active

- [ ] 当前真实 Android TV 播放链路有明确 UAT 基线。
- [ ] Android TV 能保存并恢复 API/room/device 配置。
- [ ] Android TV APK 发布、安装、更新和回滚流程可重复。
- [ ] 播放韧性和诊断覆盖真实使用中的关键失败。
- [ ] 代码和流程简化完成审计、分类、小批量清理和回归验证。
- [ ] Admin Songs 增强真实歌库运维能力。
- [ ] 真实模式部署和 smoke 验证可重复执行。

### Out of Scope

- 多房间 / 多包厢能力 — 当前仍是家庭单电视场景。
- 用户账号体系 — 家庭局域网部署暂不需要。
- 软件实时麦克风 DSP / 混响 / 回声 / EQ — 实时音频处理交给硬件链路。
- 唱歌评分、音高分析、AI 人声分离 — 不决定当前是否能稳定唱起来。
- 强制全库转码 — libVLC 路线已验证，转码只作为未来兜底。
- 复杂后台 CMS — Admin 只做曲库、资源、设备、诊断和必要运维。

## Context

项目是一个 TypeScript monorepo 加 Android TV 项目：

- `apps/api`: Fastify API、房间状态、队列、媒体网关、真实索引读写适配。
- `apps/admin`: React Admin 后台。
- `apps/mobile-controller`: React 手机控制器。
- `HomeKTV`: Android TV 正式端，Kotlin + libVLC。
- `apps/tv-player`: Web TV 调试端。
- `packages/*`: domain、protocol、player contracts、session engine、hot songs 等共享包。

真实库基础位于本地 PostgreSQL 容器 `home-ktv-postgres`，核心表包括 `ktv_index_runs`、`ktv_artists`、`ktv_songs`、`ktv_song_artists`、`ktv_song_assets`。真实媒体仍位于 NAS `/mnt/nas/KTV歌曲`。产品 runtime 不直接把 `ktv_*` ID 写入队列；点歌时将选中的 indexed asset 同步为 canonical `songs/assets` 后继续复用现有队列和播放状态机。

Android TV 是正式播放端。Web TV 仍保留为调试端，但不再作为真实 MV 播放兼容性的最终判断依据。

## Constraints

- **Product scope**: 优先稳定家庭单房间可唱链路，复杂增强能力作为后续 milestone。
- **Interaction model**: 手机是唯一控制端，电视端只负责播放、入场二维码和必要状态展示。
- **Playback model**: 播放状态由服务端状态机裁决，Android TV 上报事实，避免手机端与电视端状态漂移。
- **Audio model**: 原唱/伴奏是同一媒体文件内音轨切换，同时只播放一条音轨；音量是房间级单音量。
- **Media source**: 本地 NAS 真实歌库为主，在线歌源只保留为补充/实验能力。
- **Room model**: 当前只做单房间，但模型保留 `room`。
- **Search quality**: 中文搜索必须覆盖歌名、歌手、拼音、首字母、别名与繁简体。
- **Simplification**: 不能凭感觉删接口；必须先有依赖证据和回归证据。

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| 中心服务端作为唯一业务真相 | 点歌、队列、切歌、重连恢复都依赖一致状态 | Good |
| TV Player 与 Mobile Controller 分离 | 符合真实 KTV 使用形态，职责边界清晰 | Good |
| 第一版只做单房间，但保留 `room` 数据模型 | 当前场景简单，同时避免未来多房间时推翻模型 | Good |
| 本地歌库优先，在线歌源作为补歌层 | 在线资源不稳定，不适合作为核心依赖 | Good |
| `Song` 与 `Asset` 分离建模 | 用户点的是“歌”，系统播的是“资源” | Good |
| 一个真实 MV 文件入库为一个 Song 加一个 real-MV Asset | 与用户文件组织方式一致，避免同一 MV 被拆成原声/伴奏两首歌 | Good |
| 真实 MV 点歌不在手机端选择原声/伴奏 | 点歌沿用当时房间播放状态，服务端解析播放意图 | Good |
| 搜索可读 `ktv_*`，但队列和播放继续使用正式 `songs/assets` | 避免让 `queue_entries`、TV snapshot、播放遥测混入第二套 ID 体系 | Good |
| Android TV + libVLC 是正式 TV 播放路线 | 真实样本验证显示它对当前 NAS 格式支持更好，且音轨切换可行 | Good |
| Web TV 保留为调试端 | 浏览器播放和音轨能力不应限制真实电视体验 | Good |
| 音量使用一个房间级音量 | 当前播放同一时间只有一条音轨，分原唱/伴奏音量没有实际意义 | Good |
| 代码和流程简化独立成章 | 先审计再删除，降低破坏真实可用链路的风险 | Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

After each phase transition:

1. Requirements invalidated? Move to Out of Scope with reason.
2. Requirements validated? Move to Validated with phase reference.
3. New requirements emerged? Add to Active.
4. Decisions to log? Add to Key Decisions.
5. "What This Is" still accurate? Update if drifted.

After each milestone:

1. Review whether the core value is still the right priority.
2. Move shipped requirements to Validated.
3. Define new Active requirements only when starting the next milestone.
4. Revisit Out of Scope items that are now candidates for milestone work.
5. Update Current State and Key Decisions.

---
*Last updated: 2026-05-26 after creating v1.4 roadmap*
