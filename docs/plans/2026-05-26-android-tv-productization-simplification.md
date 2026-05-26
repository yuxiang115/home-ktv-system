# Android TV 产品化与流程简化 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把当前真实歌库 + Android TV 播放链路产品化，并安排一次有证据的代码和流程简化。

**Architecture:** Android TV 作为正式播放端，Web TV 保留为调试端；API 继续作为唯一房间状态和队列真相；Mobile 继续作为唯一用户控制端；Admin 聚焦真实歌库诊断和运维。简化工作先审计再改动，避免破坏当前可用主链路。

**Tech Stack:** Kotlin Android + libVLC、Fastify API、React Admin、React Mobile Controller、PostgreSQL、pnpm workspace、GSD planning docs。

---

### Task 1: 冻结当前真实播放基线

**Files:**
- Modify: `.planning/ROADMAP.md`
- Modify: `.planning/STATE.md`
- Modify: `docs/deployment.md`
- Test: manual UAT on Android TV and Mobile controller

**Step 1: 写基线 UAT 清单**

在部署文档中补充真实电视验收项：扫码进入、搜索真实歌曲、点歌、切歌、原唱/伴唱切换、音量、后台 TV 在线状态、控制器重进。

**Step 2: 执行当前验证命令**

Run:

```bash
pnpm -F @home-ktv/api typecheck
pnpm -F @home-ktv/mobile-controller typecheck
cd HomeKTV && ./gradlew :app:testDebugUnitTest :app:assembleDebug --no-daemon
```

Expected: 全部通过。

**Step 3: 提交**

```bash
git add .planning/ROADMAP.md .planning/STATE.md docs/deployment.md
git commit -m "补充真实播放基线"
```

### Task 2: Android TV 启动配置持久化

**Files:**
- Modify: `HomeKTV/app/src/main/java/com/liuyue/homektv/MainActivity.kt`
- Modify: `HomeKTV/README.md`
- Test: `cd HomeKTV && ./gradlew :app:testDebugUnitTest :app:assembleDebug --no-daemon`

**Step 1: 增加配置读写测试或最小可测封装**

把 `apiBaseUrl`、`room`、`deviceName` 从启动参数解析逻辑中抽出，允许 SharedPreferences 保存和恢复。

**Step 2: 实现无参数启动行为**

无 adb 参数时优先读取本地保存配置；没有保存配置时进入未配置状态，显示局域网控制/配置提示。

**Step 3: 验证重启恢复**

安装 APK 后用 adb 带参数启动一次，再完全退出并普通启动，预期仍连接同一个 API 和房间。

**Step 4: 提交**

```bash
git add HomeKTV/app/src/main/java/com/liuyue/homektv/MainActivity.kt HomeKTV/README.md
git commit -m "持久化电视端配置"
```

### Task 3: APK 发布和安装流程

**Files:**
- Modify: `HomeKTV/README.md`
- Modify: `docs/deployment.md`
- Modify: `HomeKTV/app/build.gradle.kts`
- Test: `cd HomeKTV && ./gradlew :app:assembleDebug :app:assembleRelease --no-daemon`

**Step 1: 明确版本和构建产物**

补充 debug/release APK 路径、版本号更新方式和真实电视安装命令。

**Step 2: 补充签名策略**

先支持本地 release signing placeholder，不提交私钥；README 说明如何放置本机 keystore。

**Step 3: 提交**

```bash
git add HomeKTV/README.md docs/deployment.md HomeKTV/app/build.gradle.kts
git commit -m "完善电视端发布流程"
```

### Task 4: 播放韧性和诊断

**Files:**
- Modify: `HomeKTV/app/src/main/java/com/liuyue/homektv/MainActivity.kt`
- Modify: `apps/api/src/routes/room-snapshots.ts`
- Modify: `apps/api/src/routes/control-commands.ts`
- Modify: `apps/mobile-controller/src/App.tsx`
- Test: API playback/session tests, Mobile controller tests, Android unit/build

**Step 1: 列出失败状态**

后端重启、网络断开、NAS 不可读、媒体播放失败、音轨切换失败、控制器重连分别要有可观察状态。

**Step 2: 先补测试再实现**

API 侧覆盖 snapshot/telemetry 状态，Mobile 覆盖提示文字，Android 覆盖本地状态转换。

**Step 3: 提交**

```bash
git add apps/api apps/mobile-controller HomeKTV
git commit -m "增强播放诊断"
```

### Task 5: 代码和流程简化专项

**Files:**
- Create: `docs/plans/2026-05-26-code-flow-simplification-audit.md`
- Modify after audit only: files identified by the audit
- Test: targeted tests based on removed or simplified paths

**Step 1: 审计候选**

用 `rg` 列出 Web TV 正式路径、旧双 Asset 切换逻辑、在线补歌入口、重复 snapshot 字段、重复部署 env。

**Step 2: 分类**

每项标记为：删除、保留、降级为调试能力、后续观察。

**Step 3: 小批量删除或收敛**

每批只改一类问题，并运行对应测试。不能证明无用的先不删。

**Step 4: 提交**

```bash
git add docs/plans/2026-05-26-code-flow-simplification-audit.md <changed-files>
git commit -m "简化播放流程"
```

### Task 6: Admin 真实歌库运维

**Files:**
- Modify: `apps/admin/src/songs/*`
- Modify: `apps/api/src/routes/*`
- Modify: `apps/api/src/modules/ingest/*`
- Test: Admin tests and API KTV index tests

**Step 1: 补真实歌库诊断操作**

在 Songs 诊断区域补充单曲重新检查、随机抽样检查、音轨数量/角色显示。

**Step 2: 保持 Admin 定位克制**

只做排查和修复真实歌库问题，不扩展为复杂 CMS。

**Step 3: 提交**

```bash
git add apps/admin apps/api
git commit -m "增强真实歌库运维"
```

### Task 7: 生产部署和 smoke

**Files:**
- Modify: `scripts/dev-local.sh`
- Create or modify: `scripts/smoke-real-library.mjs`
- Modify: `docs/deployment.md`
- Modify: `README.md`
- Test: real local deployment smoke

**Step 1: 收敛真实模式 profile**

将 `DATABASE_URL`、`PUBLIC_BASE_URL`、`MEDIA_ROOT`、KTV index root、NAS path mapping 写入明确 profile 或 env 示例。

**Step 2: 增加 smoke 命令**

验证 PostgreSQL、`ktv_*` 表、active asset 数、NAS 随机文件可读、API health、搜索、点歌、asset stream。

**Step 3: 提交**

```bash
git add scripts docs README.md
git commit -m "补充真实部署验证"
```
