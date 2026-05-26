# Requirements: 家庭包厢式 KTV 系统 v1.4 Android TV 产品化与流程简化

**Defined:** 2026-05-26
**Core Value:** 在家庭单电视场景下，让用户用手机完成全部点歌与控制，并稳定地把歌唱起来。

## v1.4 Requirements

### Baseline And Current Flow

- [ ] **BASE-01**: 用户可以按一份清晰 UAT 清单验证当前真实 Android TV 播放主链路：扫码、搜索、点歌、播放、切歌、音轨切换、音量和控制器重进。
- [ ] **BASE-02**: 开发者可以按文档运行 API、Mobile、Android TV 的核心 typecheck/test/build 命令。
- [ ] **BASE-03**: 文档明确 Android TV 是正式 TV 端，Web TV 是调试端，避免继续把浏览器播放限制当成正式产品限制。

### Android TV Configuration

- [ ] **ATV-01**: Android TV 端能保存 `apiBaseUrl`、`room`、`deviceName`。
- [ ] **ATV-02**: 普通启动不带 adb 参数时，Android TV 能恢复上一次有效配置。
- [ ] **ATV-03**: 首次无配置启动时，Android TV 显示清楚的中文配置/连接指引。
- [ ] **ATV-04**: API 不可达、网络异常、房间绑定失败时，Android TV 显示简洁状态并保留可排查日志。

### APK Release And Install

- [ ] **APK-01**: Android TV debug/release APK 构建命令和产物路径有文档说明。
- [ ] **APK-02**: release 签名使用本机 keystore 配置，不提交私钥。
- [ ] **APK-03**: 文档包含安装、覆盖安装、清数据、启动、回滚和真实电视测试步骤。
- [ ] **APK-04**: Android TV README 说明它与 Web TV 调试端的职责边界。

### Playback Resilience And Diagnostics

- [ ] **RES-01**: 后端重启、TV 重连后，Mobile/Admin 的电视在线状态能自动恢复。
- [ ] **RES-02**: NAS 文件缺失、不可读、stream 失败时，Mobile/Admin/TV 中至少一个相关界面显示可执行中文提示。
- [ ] **RES-03**: 音轨切换失败时，当前播放保持稳定，控制器提示失败，Android TV 或 API 日志能定位 song/asset/url。
- [ ] **RES-04**: Android TV 播放失败 telemetry 包含当前媒体 URL、当前歌曲、资产标识和失败阶段。
- [ ] **RES-05**: 手机控制器退出后重新扫码或打开 URL，可以恢复当前队列和播放状态。

### Code And Flow Simplification

- [ ] **SIMP-01**: 审计并分类 Web TV 正式/调试职责、旧双 Asset 切换逻辑、真实 MV 单 Asset 模型、在线补歌入口、snapshot/control 重复字段、部署 env 重复项。
- [ ] **SIMP-02**: 每个简化候选都有处理结论：删除、保留、调试端保留、后续观察。
- [ ] **SIMP-03**: 删除或收敛旧接口前必须有 `rg` 依赖证据、测试证据或手动 UAT 证据。
- [ ] **SIMP-04**: 对外协议、数据库字段、命令行入口的移除或降级必须更新 README/部署文档。
- [ ] **SIMP-05**: 简化后，主链路仍能通过 Phase 20 基线 UAT。

### Admin Real Library Operations

- [ ] **OPS-01**: Admin Songs 诊断能查看真实索引来源、文件路径、文件可读性、canonical sync 状态和 parse confidence。
- [ ] **OPS-02**: Admin 能对单个真实歌曲/资产执行重新检查。
- [ ] **OPS-03**: Admin 能执行有上限的随机抽样检查，验证 NAS 文件可读和音轨数量分布。
- [ ] **OPS-04**: Admin 能展示音轨数量、原唱/伴奏角色证据和需要人工确认的原因。

### Deployment And Verification

- [ ] **DEPLOY-01**: 真实模式部署有一套明确 env/profile，覆盖 `DATABASE_URL`、`PUBLIC_BASE_URL`、`MEDIA_ROOT`、KTV index root、NAS path mapping 和服务 URL。
- [ ] **DEPLOY-02**: 一键/单 profile 启动 API、Admin、Mobile，并保留各自日志和 tail 命令。
- [ ] **DEPLOY-03**: smoke 命令能检查 PostgreSQL、`ktv_*` counts、NAS 随机文件可读、API health、搜索、点歌同步、asset stream 和 TV snapshot。
- [ ] **DEPLOY-04**: 文档包含 Android TV 安装、启动、配置恢复和排障步骤。
- [ ] **VERIFY-01**: 人工 UAT 文档能让用户直接验证真实搜索到播放闭环，不再出现“不知道要验证什么”的问题。
- [ ] **VERIFY-02**: 里程碑审计能把 v1.4 每个 requirement 映射到实现和验证证据。

## Future Requirements

### Media Processing

- **PROC-01**: 对少数无法被 Android TV/libVLC 稳定播放的文件提供批量 remux/transcode 兜底。
- **PROC-02**: Admin 可查看预处理任务进度、日志、失败原因和重试。

### Advanced TV Experience

- **TVUX-01**: Android TV 支持遥控器最小操作，如刷新二维码、显示设备信息、进入配置页。
- **TVUX-02**: Android TV 支持更精细的画面比例选项，但默认保持不裁剪。

### Ranking And Discovery

- **RANK-01**: 搜索排序接入热门歌曲、最近点唱和本地使用频率。

## Out of Scope

Explicitly excluded for v1.4.

| Feature | Reason |
|---------|--------|
| 多房间 | 当前产品仍是家庭单电视单房间。 |
| 用户账号体系 | 家庭局域网场景暂不需要。 |
| 唱歌评分和实时 DSP | 与核心播放链路无关，且硬件链路更适合处理声音效果。 |
| 强制全库转码 | 真实电视已经验证 libVLC 方案可行，转码只作为未来兜底。 |
| 大型后台 CMS | Admin 当前定位是诊断和运维。 |
| 在线 Provider 接入 | 当前核心价值来自本地 NAS 真实歌库。 |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| BASE-01 | Phase 20 | Pending |
| BASE-02 | Phase 20 | Pending |
| BASE-03 | Phase 20 | Pending |
| ATV-01 | Phase 21 | Pending |
| ATV-02 | Phase 21 | Pending |
| ATV-03 | Phase 21 | Pending |
| ATV-04 | Phase 21 | Pending |
| APK-01 | Phase 22 | Pending |
| APK-02 | Phase 22 | Pending |
| APK-03 | Phase 22 | Pending |
| APK-04 | Phase 22 | Pending |
| RES-01 | Phase 23 | Pending |
| RES-02 | Phase 23 | Pending |
| RES-03 | Phase 23 | Pending |
| RES-04 | Phase 23 | Pending |
| RES-05 | Phase 23 | Pending |
| SIMP-01 | Phase 24 | Pending |
| SIMP-02 | Phase 24 | Pending |
| SIMP-03 | Phase 24 | Pending |
| SIMP-04 | Phase 24 | Pending |
| SIMP-05 | Phase 24 | Pending |
| OPS-01 | Phase 25 | Pending |
| OPS-02 | Phase 25 | Pending |
| OPS-03 | Phase 25 | Pending |
| OPS-04 | Phase 25 | Pending |
| DEPLOY-01 | Phase 26 | Pending |
| DEPLOY-02 | Phase 26 | Pending |
| DEPLOY-03 | Phase 26 | Pending |
| DEPLOY-04 | Phase 26 | Pending |
| VERIFY-01 | Phase 26 | Pending |
| VERIFY-02 | Phase 26 | Pending |

**Coverage:**

- v1.4 requirements: 31 total
- Mapped to phases: 31
- Unmapped: 0

---
*Requirements defined: 2026-05-26*
*Last updated: 2026-05-26 after creating v1.4 roadmap*
