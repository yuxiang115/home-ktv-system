# 项目结构与双部署模式设计

**日期:** 2026-05-26
**目标:** 让 HomeKTV 支持长期可维护的目录结构、本地开发、GitHub 推送、服务器拉取部署测试，并同时支持 Docker Compose 部署和源码部署。

## 设计原则

1. 产品职责比技术历史更重要。目录名应该表达“它是什么”，而不是最早怎么实现。
2. 部署入口独立于开发入口。本地开发脚本不应该兼任服务器部署脚本。
3. Docker 和源码部署共享同一套环境变量语义，减少排查成本。
4. Android TV 是客户端，不是服务器服务。服务器只部署 API、Admin、Controller、数据库和静态资源。
5. 迁移可以大，但要保留短期兼容命令，避免一次结构调整破坏日常开发。

## 目标目录结构

```text
home-ktv-system/
├── apps/
│   ├── api/                 # 后端 API、媒体网关、房间状态、真实索引接入
│   ├── admin/               # 后台管理界面
│   ├── controller/          # 手机扫码控制器
│   └── tv-web/              # Web TV 调试端
├── clients/
│   └── android-tv/          # Android TV 正式播放端
├── packages/
│   ├── domain/
│   ├── protocol/
│   ├── player-contracts/
│   ├── session-engine/
│   └── hot-songs/
├── deploy/
│   ├── docker/              # Docker Compose 部署
│   ├── source/              # 服务器源码部署
│   └── env/                 # 环境变量模板
├── scripts/
│   ├── dev/                 # 本地开发入口
│   ├── db/                  # 数据库/迁移包装入口
│   └── tools/               # seed、视觉检查、风险扫描等工具
├── docs/
└── README.md
```

## 命名调整

- `HomeKTV/` -> `clients/android-tv/`
- `apps/mobile-controller/` -> `apps/controller/`
- `apps/tv-player/` -> `apps/tv-web/`
- `scripts/dev-local.*` -> `scripts/dev/dev-local.*`
- 工具脚本移动到 `scripts/tools/`

短期保留根命令和旧 package 过滤器的等价入口，降低迁移冲击。

## Docker Compose 部署

服务器拉取代码后，使用：

```bash
bash deploy/docker/ktv.sh setup
bash deploy/docker/ktv.sh start
bash deploy/docker/ktv.sh restart
bash deploy/docker/ktv.sh status
bash deploy/docker/ktv.sh logs
bash deploy/docker/ktv.sh stop
```

Compose 服务：

- `postgres`
- `api`
- `admin`
- `controller`

API 容器启动前执行数据库迁移。Admin 和 Controller 使用 Nginx 托管构建后的静态资源。

## 源码部署

服务器也可以不使用 Docker 运行应用进程：

```bash
bash deploy/source/ktv.sh setup
bash deploy/source/ktv.sh start
bash deploy/source/ktv.sh restart
bash deploy/source/ktv.sh status
bash deploy/source/ktv.sh logs
bash deploy/source/ktv.sh stop
```

源码部署负责：

- 安装 pnpm 依赖。
- 构建 packages、API、Admin、Controller。
- 执行数据库迁移。
- 后台启动 API、Admin preview、Controller preview。
- 写入 `runtime/logs/` 和 `runtime/pids/`。

## 环境变量

Docker 和源码部署共享核心变量：

```bash
DATABASE_URL=
PUBLIC_BASE_URL=
CONTROLLER_BASE_URL=
MEDIA_ROOT=
MEDIA_PATH_MAPPINGS=
TV_ROOM_SLUG=living-room
KTV_NAS_HOST_PATH=
KTV_MEDIA_HOST_PATH=
```

`KTV_NAS_HOST_PATH` 是服务器上的 NAS 挂载路径。`MEDIA_PATH_MAPPINGS` 把索引中的 NAS 路径映射到容器或源码运行时可读路径。

## 成功标准

- 根 README 能说明本地开发、Docker 部署、源码部署和 Android TV 安装的主路径。
- 服务器部署只需要 `setup/start/restart/status/logs/stop` 这组命令。
- Docker 和源码部署都先执行迁移，避免数据库列缺失导致运行时 42703。
- 目录结构表达产品职责，不再把正式 Android TV 放在根目录。
- 关键路径通过 typecheck/build 或部署脚本 dry-run/config 检查。
