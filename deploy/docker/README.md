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
bash deploy/docker/ktv.sh logs
bash deploy/docker/ktv.sh logs api
bash deploy/docker/ktv.sh stop
```

`deploy/docker/.env` 从 `deploy/env/server.env.example` 生成。`PUBLIC_BASE_URL` 和 `CONTROLLER_BASE_URL` 必须是手机和 Android TV 可访问的服务器地址。

真实 NAS 曲库需要重点检查：

```bash
KTV_NAS_HOST_PATH=/mnt/nas/KTV歌曲
DOCKER_MEDIA_PATH_MAPPINGS=/mnt/nas/KTV歌曲=/nas/KTV歌曲
```

容器内 API 会使用 `DOCKER_DATABASE_URL` 连接 Compose 内的 PostgreSQL。源码部署才使用 `DATABASE_URL`。
