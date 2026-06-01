# HomeKTV API

`apps/api` 是 HomeKTV 的后端服务。它负责房间状态、播放队列、控制命令、媒体网关、NAS 曲库接入、在线候选任务、TV 心跳和播放遥测。

## 职责

- 管理房间、配对 token、控制器会话和 TV 在线状态。
- 接收手机控制器命令：点歌、顶歌、切歌、原唱/伴唱切换、音量调整。
- 为 TV 端生成 `room snapshot`、`playback target` 和媒体播放 URL。
- 通过 `/media/nas/:assetId` 把 NAS 媒体文件以 HTTP Range 方式提供给 TV。
- 接入 PostgreSQL 曲库、真实 KTV 索引和在线候选任务。

## 关键目录

```text
apps/api/src/routes/       # HTTP 路由
apps/api/src/modules/      # 业务模块
apps/api/src/db/           # schema 和迁移
apps/api/scripts/          # 数据库迁移脚本
```

## 环境变量

```bash
DATABASE_URL=postgres://ktv:ktv@127.0.0.1:5432/home_ktv
MEDIA_ROOT="$(pwd)/home-ktv-media"
PUBLIC_BASE_URL=http://<LAN_IP>:4000
CONTROLLER_BASE_URL=http://<LAN_IP>:5176
MEDIA_PATH_MAPPINGS=/mnt/nas/KTV歌曲=/mnt/nas/KTV歌曲
```

`PUBLIC_BASE_URL` 必须使用手机和电视都能访问的局域网地址，不要用 `localhost`。

`MEDIA_PATH_MAPPINGS` 用于把数据库里的 NAS 路径映射到当前机器实际可读路径。

## 常用命令

从项目根目录运行：

```bash
pnpm db:migrate
pnpm -F @home-ktv/api dev
pnpm -F @home-ktv/api test
pnpm -F @home-ktv/api typecheck
```

本地推荐使用统一部署脚本：

```bash
pnpm dev:local start
pnpm dev:local tail api
```

## 重要接口

```text
GET  /health
GET  /rooms/:roomSlug/snapshot
GET  /rooms/:roomSlug/realtime
POST /rooms/:roomSlug/commands/add-queue-entry
POST /rooms/:roomSlug/commands/skip-current
POST /rooms/:roomSlug/commands/switch-vocal-mode
POST /rooms/:roomSlug/commands/set-volume
POST /player/bootstrap
POST /player/heartbeat
POST /player/telemetry
GET  /media/nas/:assetId
GET  /media/covers/nas/*
```

## 相关文档

- [部署说明](../../docs/deployment.md)
- [项目结构](../../docs/project-structure.md)
- [KTV 全量索引](../../docs/KTV-FULL-INDEX.md)
- [数据库结构](../../docs/database-schema.md)
