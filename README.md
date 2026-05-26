# HomeKTV System

HomeKTV 是一个面向家庭 KTV 场景的点歌、播放和曲库管理系统。当前产品按三个主要部分组织：后端与后台、TV 端、手机控制器。

## 产品结构

```text
home-ktv-system/
├── apps/api/                 # 后端 API、房间状态、播放队列、媒体网关
├── apps/admin/               # KTV 后台管理界面
├── HomeKTV/                  # Android TV 正式播放端
├── apps/mobile-controller/   # 手机扫码点歌控制器
├── apps/tv-player/           # Web TV 调试端
├── packages/                 # 共享领域模型、协议、会话引擎、热门歌曲工具
├── scripts/                  # 本地部署、demo 数据、视觉检查脚本
├── docs/                     # 架构、部署、曲库接入和产品化文档
└── home-ktv-media/           # 本地媒体目录，运行时生成，不入库
```

更完整的结构说明见 [docs/project-structure.md](docs/project-structure.md)。

## 三个主要部分

### 后端与后台

- 后端 API: [apps/api](apps/api/README.md)
- 后台管理界面: [apps/admin](apps/admin/README.md)
- 共享领域模型和播放契约: `packages/domain`、`packages/player-contracts`、`packages/protocol`、`packages/session-engine`

后端负责 PostgreSQL 数据、房间状态、队列命令、媒体文件访问、TV 心跳和控制器会话。后台提供房间、曲库、导入、诊断和管理操作。

### TV 端

- Android TV 正式端: [HomeKTV](HomeKTV/README.md)
- Web TV 调试端: [apps/tv-player](apps/tv-player/README.md)

正式播放体验以 Android TV + libVLC 为准，支持真实 KTV MV、双音轨原唱/伴唱切换、二维码配对和播放状态上报。

### 控制器

- 手机控制器: [apps/mobile-controller](apps/mobile-controller/README.md)

用户通过 TV 上的二维码进入控制器，搜索曲库、点歌、顶歌、切歌和切换原唱/伴唱。

## 部署与运行

本地一键启动：

```bash
pnpm dev:local start
```

常用本地部署、Android TV 安装、NAS 媒体路径和排障说明见 [docs/deployment.md](docs/deployment.md)。

## 热门歌曲抓取

热门歌曲榜单工具集中在 [packages/hot-songs](packages/hot-songs/README.md)。根目录命令：

```bash
pnpm hot-songs:update
```

## 常用命令

```bash
pnpm install
pnpm db:migrate
pnpm dev:local start
pnpm dev:local status
pnpm dev:local tail api
pnpm test
pnpm build
```

## 本地资源目录

这些目录是本地运行资源或生成产物，默认不提交：

- `home-ktv-media/`: 本地媒体、生成的 web-compatible 文件、demo 歌曲。
- `logs/`: `pnpm dev:local` 生成的服务日志。
- `songs-sample/`: 本地 MV 样本文件。
- `.planning/reports/`: GSD 工作流和调研报告。
