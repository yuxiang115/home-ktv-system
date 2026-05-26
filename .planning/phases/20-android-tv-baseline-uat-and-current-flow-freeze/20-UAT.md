---
status: testing
phase: 20-android-tv-baseline-uat-and-current-flow-freeze
source:
  - .planning/phases/20-android-tv-baseline-uat-and-current-flow-freeze/20-01-PLAN.md
  - .planning/phases/20-android-tv-baseline-uat-and-current-flow-freeze/20-02-PLAN.md
started: 2026-05-26T21:55:00+08:00
updated: 2026-05-26T21:55:00+08:00
---

## Current Test

number: 1
name: Android TV Real Playback Baseline
expected: |
  请按 `docs/deployment.md` 的“真实 Android TV 基线验证”执行。预期结果：
  1. API health 正常。
  2. Android TV 空闲页显示二维码。
  3. 手机扫码进入控制器后显示电视在线。
  4. 搜索真实歌曲可以点歌。
  5. Android TV 开始播放真实 MV。
  6. 切歌、顶歌、删除、音量控制可用。
  7. 使用一首确认有双音轨的歌曲时，原唱/伴唱切换后 TV 左下角模式或音轨编号变化。
  8. 关闭手机页面再重新扫码/打开控制器，队列和当前播放状态能恢复。
awaiting: user response

## Tests

### 1. Android TV Real Playback Baseline
expected: 真实 Android TV 主链路按部署文档通过，覆盖扫码、搜索、点歌、播放、切歌、队列操作、音量、音轨切换和控制器重进。
result: [pending]

### 2. Automated Verification Commands
expected: 以下命令能在开发机通过：API typecheck、Mobile typecheck、Android unit/build。
result: [pending]
commands:
  - `pnpm -F @home-ktv/api typecheck`
  - `pnpm -F @home-ktv/mobile-controller typecheck`
  - `cd HomeKTV && ./gradlew :app:testDebugUnitTest :app:assembleDebug --no-daemon`

### 3. Android TV vs Web TV Boundary
expected: 文档明确 Android TV 是正式 TV 播放端，Web TV 是调试端；浏览器 autoplay/音轨限制不作为真实电视产品阻塞项。
result: [pending]

## Known Current Limitations

- Android TV 无参数启动和配置持久化属于 Phase 21。
- APK release 签名、安装更新和回滚 runbook 属于 Phase 22。
- 后端重启、网络异常、NAS 不可读、播放失败、音轨切换失败的诊断增强属于 Phase 23。
- Web TV/debug path、旧双 Asset 假设、在线补歌入口和重复控制字段的清理属于 Phase 24。

## Summary

passed: 0
issues: 0
pending: 3
skipped: 0
blocked: 0

## Gaps

[none yet]
