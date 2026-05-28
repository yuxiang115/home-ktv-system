# 项目结构

HomeKTV 按产品职责组织目录：`apps` 放服务器和 Web 应用，`clients` 放原生客户端，`packages` 放共享包，`deploy` 放服务器部署，`scripts` 放本地开发和工具脚本。

## 顶层结构

```text
home-ktv-system/
├── apps/
├── clients/
├── packages/
├── deploy/
├── scripts/
├── docs/
├── .planning/
├── runtime/
├── logs/
└── home-ktv-media/
```

`runtime/`、`logs/`、`home-ktv-media/` 是本地或服务器运行产物，不进入版本库。`.planning/` 是 GSD 过程档案，不是运行时必需目录。

## 应用层

```text
apps/api/
apps/admin/
apps/controller/
apps/tv-web/
```

`apps/api` 是系统后端，提供房间、队列、媒体、曲库、导入、TV 心跳、控制器会话、真实 KTV 索引接入等 API。

`apps/admin` 是后台管理界面，面向维护者，用于查看房间状态、曲库、导入结果和诊断信息。

`apps/controller` 是手机扫码后的点歌界面。它面向用户，负责搜索、点歌、顶歌、切歌、原唱/伴唱切换和音量控制。

`apps/tv-web` 是 Web TV 调试端，保留用于浏览器调试和历史兼容，不作为真实电视播放体验的主路径。

## 客户端

```text
clients/android-tv/
```

`clients/android-tv` 是 Android TV 正式播放端。它使用 Kotlin + libVLC，目标是直接播放真实 KTV MV，支持双音轨切换和二维码配对。

## 共享包

```text
packages/domain/
packages/player-contracts/
packages/protocol/
packages/session-engine/
packages/hot-songs/
```

`domain`、`player-contracts`、`protocol` 和 `session-engine` 是后端、后台、控制器和 TV 共享的领域模型与协议层。

`hot-songs` 是热门歌曲工具，包含榜单来源 adapter、归一化、融合、报告和测试。详细说明见 [../packages/hot-songs/README.md](../packages/hot-songs/README.md)。

## 部署

```text
deploy/docker/
deploy/source/
deploy/env/
```

`deploy/docker` 提供 Docker Compose 部署。`deploy/source` 提供服务器源码部署。两者共享 `deploy/env` 中的环境变量模板。

## 脚本

```text
scripts/dev/
scripts/tools/
```

`scripts/dev` 是本地开发入口，负责启动 API、后台、Web TV 和手机控制器，并把日志写到 `logs/dev/`。

`scripts/tools` 放 demo 数据、视觉检查、真实 MV 风险扫描等工具。

## 文档

```text
docs/
docs/archive/
docs/plans/
docs/reports/
```

`docs/` 放长期有效的架构、部署、曲库和产品说明。`docs/archive/` 放已过期但仍有参考价值的历史设计。`docs/plans/` 放阶段性设计和实施计划。`docs/reports/` 放验证报告和分析结果。

日常入口优先级：

1. `README.md`
2. `docs/KTV-ARCHITECTURE.md`
3. `docs/deployment.md`
4. `docs/KTV-FULL-INDEX.md`
5. `docs/runbooks/`

`docs/plans/` 和 `.planning/` 中可能保留旧路径、旧决策或历史 UAT 记录，不应直接作为当前实现依据。
