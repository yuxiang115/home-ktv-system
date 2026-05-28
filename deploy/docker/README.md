# Docker 部署

服务器拉取代码后：

```bash
bash deploy/docker/ktv.sh setup
vim deploy/docker/.env
bash deploy/docker/ktv.sh start
```

常用命令：

```bash
bash deploy/docker/ktv.sh restart
bash deploy/docker/ktv.sh status
bash deploy/docker/ktv.sh doctor
bash deploy/docker/ktv.sh logs
bash deploy/docker/ktv.sh logs api
bash deploy/docker/ktv.sh probe-index -- --limit 300 --concurrency 2
bash deploy/docker/ktv.sh tag-styles -- --limit 300 --dry-run
bash deploy/docker/ktv.sh stop
```

`doctor` 会对刚重启后常见的 502/503/504 等公网反代临时状态做短重试，避免 `restart && doctor` 因 API 刚恢复时序产生误报。500 等后端错误仍会直接标记失败。

`deploy/docker/.env` 从 `deploy/env/server.env.example` 生成。`PUBLIC_BASE_URL` 和 `CONTROLLER_BASE_URL` 必须是手机、Web TV 和 Android TV 可访问的服务器地址。
公网分域名部署时也应设置 `ADMIN_BASE_URL` 和 `TV_WEB_BASE_URL`，这样自检脚本能准确验证 CORS 与入口地址。

当前产品边界：

- Admin 不加登录鉴权，公网暴露范围由部署网络、Caddy 和域名策略控制。
- 媒体流不做 token 或签名 URL 访问控制。
- Android TV APK 不通过服务端自动更新，采用本地打包后覆盖安装。

真实 NAS 曲库需要重点检查：

```bash
KTV_NAS_HOST_PATH=/mnt/nas/KTV歌曲
DOCKER_MEDIA_PATH_MAPPINGS=/mnt/nas/KTV歌曲=/nas/KTV歌曲
```

真实曲库音轨元数据探测先跑小样本：

```bash
bash deploy/docker/ktv.sh probe-index -- --limit 300 --concurrency 2
```

确认耗时和失败率可接受后，再全量高并发回填：

```bash
bash deploy/docker/ktv.sh probe-index -- --concurrency 8 --retry-failed
```

探测只保存 `mediaInfoSummary`、`mediaInfoProvenance` 和失败摘要，不保存完整 ffprobe raw JSON。探测失败不会影响搜索、点歌或播放。

真实曲库风格标签先跑网易云 API 小样本：

```bash
bash deploy/docker/ktv.sh tag-styles -- --limit 300 --dry-run
bash deploy/docker/ktv.sh tag-styles -- --limit 300 --apply
```

`tag-styles` 默认只处理缺失 `netease-playlist-v1` 标签的歌曲；如需重跑全部样本，加 `--all`。

容器内 API 会使用 `DOCKER_DATABASE_URL` 连接 Compose 内的 PostgreSQL。源码部署才使用 `DATABASE_URL`。

当前 Compose 会启动：

```text
api         4000
admin       5174
controller  5176
tv-web      5173
postgres    5432
```

lxc-dev 测试环境的公网入口：

```text
https://ktv-api.shaolongfei.com/health
https://ktv-admin.shaolongfei.com/
https://ktv-controller.shaolongfei.com/controller?room=living-room
https://ktv-tv.shaolongfei.com/?apiBaseUrl=https://ktv-api.shaolongfei.com&roomSlug=living-room&deviceName=Web%20TV
```
