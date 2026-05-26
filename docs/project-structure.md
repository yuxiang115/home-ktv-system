# 项目结构

HomeKTV 当前保持 monorepo 结构，但产品边界按三个部分理解：后端与后台、TV 端、控制器。现阶段不大规模移动源码目录，避免破坏已有脚本、pnpm workspace、Turbo 和 Android Gradle 配置。

## 后端与后台

```text
apps/api/
apps/admin/
packages/domain/
packages/player-contracts/
packages/protocol/
packages/session-engine/
```

`apps/api` 是系统后端，提供房间、队列、媒体、曲库、导入、TV 心跳和控制器会话等 API。

`apps/admin` 是后台管理界面，面向维护者，用于查看房间状态、曲库、导入结果和诊断信息。

`packages/domain`、`packages/player-contracts`、`packages/protocol` 和 `packages/session-engine` 是后端、后台、控制器和 TV 共享的领域模型与协议层。

## TV 端

```text
HomeKTV/
apps/tv-player/
```

`HomeKTV` 是 Android TV 正式播放端。它使用 Kotlin + libVLC，目标是直接播放真实 KTV MV，支持双音轨切换和二维码配对。

`apps/tv-player` 是 Web TV 调试端，保留用于浏览器调试和历史兼容，不作为真实电视播放体验的主路径。

## 控制器

```text
apps/mobile-controller/
```

控制器是手机扫码后的点歌界面。它面向用户，负责搜索、点歌、顶歌、切歌和原唱/伴唱切换。

## 热门歌曲工具

```text
packages/hot-songs/
```

热门歌曲工具独立在 package 内，包含榜单来源 adapter、归一化、融合、报告和测试。详细说明见 [../packages/hot-songs/README.md](../packages/hot-songs/README.md)。

## 脚本与部署

```text
scripts/dev-local.sh
scripts/dev-local.mjs
scripts/seed-demo-song.mjs
scripts/tv-visual-check.mjs
scripts/ui-visual-check.mjs
```

`scripts/dev-local.*` 是本地部署入口，负责启动 API、后台、Web TV 和手机控制器，并把日志写到 `logs/dev/`。

更多部署说明见 [deployment.md](deployment.md)。

## 本地运行资源

```text
home-ktv-media/
logs/
songs-sample/
```

这些目录不进入版本库。真实媒体文件、生成媒体、日志和样本都属于本地状态。

## 文档目录

```text
docs/
docs/plans/
docs/reports/
```

`docs/` 放长期有效的架构、部署、曲库和产品说明。`docs/plans/` 放阶段性设计和实施计划。`docs/reports/` 放验证报告和分析结果。
