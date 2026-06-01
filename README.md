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
├── docs/                    # 当前架构、部署、曲库和运维文档
└── runtime/                 # 源码部署运行时目录，生成产物不入库
```

更完整的结构说明见 [docs/project-structure.md](docs/project-structure.md)。

## 当前产品边界

- Admin 暂不做登录鉴权，只作为家庭局域网/受控公网入口下的运维管理台。
- 公网媒体流暂不做访问控制，安全边界交给部署网络、反向代理和域名暴露范围。
- Android TV APK 由本地手动打包，通过覆盖安装更新到电视。
- 真实曲库走全自动索引和入库路径，Admin 用于查看、诊断和管理资源，不做人工作为歌曲可用性的前置审核。
- 单音轨歌曲可以点歌播放，但控制端会显示“单音轨歌曲源”，提示该资源没有双音轨原唱/伴唱切换能力。

## 三个主要部分

### 后端与后台

- 后端 API: [apps/api](apps/api/README.md)
- 后台管理界面: [apps/admin](apps/admin/README.md)
- 共享领域模型和播放契约: `packages/domain`、`packages/player-contracts`、`packages/protocol`、`packages/session-engine`

后端负责 PostgreSQL 数据、房间状态、队列命令、媒体文件访问、TV 心跳和控制器会话。后台提供房间、NAS 曲库、在线候选任务、诊断和管理操作。

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
pnpm repo:hygiene
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
bash deploy/docker/ktv.sh doctor
bash deploy/docker/ktv.sh logs
```

源码部署：

```bash
bash deploy/source/ktv.sh setup
bash deploy/source/ktv.sh deploy
bash deploy/source/ktv.sh status
bash deploy/source/ktv.sh doctor
bash deploy/source/ktv.sh logs
```

部署总览见 [docs/deployment.md](docs/deployment.md)。Docker 方式见 [docs/deployment-docker.md](docs/deployment-docker.md)，源码方式见 [docs/deployment-source.md](docs/deployment-source.md)。
服务器运维步骤见 [docs/runbooks/deploy-lxc-dev.md](docs/runbooks/deploy-lxc-dev.md)，故障排查见 [docs/runbooks/troubleshooting.md](docs/runbooks/troubleshooting.md)，仓库卫生见 [docs/runbooks/repo-hygiene.md](docs/runbooks/repo-hygiene.md)，发布检查见 [docs/runbooks/release-checklist.md](docs/runbooks/release-checklist.md)。

## 文档入口

- [文档总入口](docs/README.md)
- [当前架构](docs/KTV-ARCHITECTURE.md)
- [项目结构](docs/project-structure.md)
- [部署说明](docs/deployment.md)
- [真实曲库索引](docs/KTV-FULL-INDEX.md)
- [数据库结构](docs/database-schema.md)

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

## 真实曲库维护

真实曲库索引、技术探测、封面拉取和风格标签流程见 [docs/KTV-FULL-INDEX.md](docs/KTV-FULL-INDEX.md)。风格标签直接保存在 `ktv_songs.style_tags` 数组字段中，批量补标签使用独立 Python runner：

```bash
python3 scripts/tools/run_style_tagging_llm_batch.py run --max-existing-tags 1 --batch-size 30 --output runtime/tagging/llm/llm-style-tags.jsonl
python3 scripts/tools/run_style_tagging_llm_batch.py import --output runtime/tagging/llm/llm-style-tags.jsonl --dry-run
python3 scripts/tools/run_style_tagging_llm_batch.py import --output runtime/tagging/llm/llm-style-tags.jsonl --apply
```

## 本地资源目录

这些目录是本地运行资源或生成产物，默认不提交：

- `home-ktv-media/`: 本地媒体缓存、封面缓存和可选测试媒体。
- `logs/`: `pnpm dev:local` 生成的服务日志。
- `runtime/`: 源码部署运行时日志、pid 和静态产物。
- `songs-sample/`: 本地 MV 样本文件。
- `.planning/reports/`: GSD 工作流和临时调研报告。

`.planning/` 是过程档案，不作为当前实现、部署或排障依据。当前说明优先看 [docs/README.md](docs/README.md) 中列出的文档入口。
