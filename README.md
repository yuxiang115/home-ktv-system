# HomeKTV System

HomeKTV 是一个面向家庭 KTV 场景的点歌、播放和曲库管理系统。当前工程按产品职责组织：后端与后台、手机控制器、TV 客户端、共享包和部署入口。

## 目录结构

```text
home-ktv-system/
├── apps/
│   ├── api/                 # 后端 API、房间状态、播放队列、媒体网关
│   ├── admin/               # KTV 后台管理界面
│   ├── controller/          # 手机扫码点歌控制器
│   └── tv-web/              # Web TV 调试端
├── clients/
│   └── android-tv/          # Android TV 正式播放端
├── packages/                # 共享领域模型、协议、会话引擎、热门歌曲工具
├── deploy/                  # Docker 和源码部署入口
├── scripts/                 # 本地开发和工具脚本
├── docs/                    # 架构、部署、曲库接入和产品化文档
└── runtime/                 # 源码部署运行时目录，生成产物不入库
```

更完整的结构说明见 [docs/project-structure.md](docs/project-structure.md)。

## 三个主要部分

### 后端与后台

- 后端 API: [apps/api](apps/api/README.md)
- 后台管理界面: [apps/admin](apps/admin/README.md)
- 共享领域模型和播放契约: `packages/domain`、`packages/player-contracts`、`packages/protocol`、`packages/session-engine`

后端负责 PostgreSQL 数据、房间状态、队列命令、媒体文件访问、TV 心跳和控制器会话。后台提供房间、曲库、导入、诊断和管理操作。

### TV 端

- Android TV 正式端: [clients/android-tv](clients/android-tv/README.md)
- Web TV 调试端: [apps/tv-web](apps/tv-web/README.md)

正式播放体验以 Android TV + libVLC 为准，支持真实 KTV MV、双音轨原唱/伴唱切换、二维码配对和播放状态上报。

### 控制器

- 手机控制器: [apps/controller](apps/controller/README.md)

用户通过 TV 上的二维码进入控制器，搜索曲库、点歌、顶歌、切歌、切换原唱/伴唱和调整音量。

## 本地开发

```bash
pnpm install
pnpm db:migrate
pnpm dev:local start
```

常用命令：

```bash
pnpm dev:local status
pnpm dev:local tail api
pnpm typecheck
pnpm test
pnpm build
```

本地开发说明见 [docs/deployment-local.md](docs/deployment-local.md)。

## 服务器部署

Docker Compose 部署：

```bash
bash deploy/docker/ktv.sh setup
bash deploy/docker/ktv.sh start
bash deploy/docker/ktv.sh status
bash deploy/docker/ktv.sh logs
```

源码部署：

```bash
bash deploy/source/ktv.sh setup
bash deploy/source/ktv.sh start
bash deploy/source/ktv.sh status
bash deploy/source/ktv.sh logs
```

部署总览见 [docs/deployment.md](docs/deployment.md)。Docker 方式见 [docs/deployment-docker.md](docs/deployment-docker.md)，源码方式见 [docs/deployment-source.md](docs/deployment-source.md)。

## Android TV

```bash
cd clients/android-tv
./gradlew :app:testDebugUnitTest :app:assembleDebug --no-daemon
```

APK 输出：

```text
clients/android-tv/app/build/outputs/apk/debug/app-debug.apk
```

## 热门歌曲抓取

热门歌曲榜单工具集中在 [packages/hot-songs](packages/hot-songs/README.md)。根目录命令：

```bash
pnpm hot-songs:update
```

## 本地资源目录

这些目录是本地运行资源或生成产物，默认不提交：

- `home-ktv-media/`: 本地媒体、生成的 web-compatible 文件、demo 歌曲。
- `logs/`: `pnpm dev:local` 生成的服务日志。
- `runtime/`: 源码部署运行时日志、pid 和静态产物。
- `songs-sample/`: 本地 MV 样本文件。
- `.planning/reports/`: GSD 工作流和调研报告。
