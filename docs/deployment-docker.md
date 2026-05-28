# Docker Compose 部署

Docker 部署适合服务器通过 Git 拉取代码后运行。它会启动 PostgreSQL、API、Admin、Controller 和 Web TV。

## 第一次部署

```bash
git clone git@github.com:ShaoLongFei/home-ktv-system.git
cd home-ktv-system

bash deploy/docker/ktv.sh setup
vim deploy/docker/.env
bash deploy/docker/ktv.sh start
bash deploy/docker/ktv.sh status
```

`deploy/docker/.env` 从 `deploy/env/server.env.example` 生成。至少需要检查：

```bash
PUBLIC_BASE_URL=http://<server-ip>:4000
ADMIN_BASE_URL=http://<server-ip>:5174
CONTROLLER_BASE_URL=http://<server-ip>:5176
TV_WEB_BASE_URL=http://<server-ip>:5173
CORS_ALLOWED_ORIGINS=http://<server-ip>:5174,http://<server-ip>:5176,http://<server-ip>:5173
KTV_NAS_HOST_PATH=/mnt/nas/KTV歌曲
NETEASE_API_BASE_URL=http://<netease-api-host>:3301
```

当前安全边界保持轻量：Admin 暂不加登录鉴权，公网媒体流暂不做访问控制。生产暴露范围需要通过 Caddy、域名、网络入口和服务器访问策略控制。

## lxc-dev 当前部署

当前测试部署运行在 `lxc-dev`，公网入口由 `lxc-network` 上的 Caddy 反代：

```text
API:        https://ktv-api.shaolongfei.com
Admin:      https://ktv-admin.shaolongfei.com
Controller: https://ktv-controller.shaolongfei.com/controller?room=living-room
Web TV:     https://ktv-tv.shaolongfei.com/?apiBaseUrl=https://ktv-api.shaolongfei.com&roomSlug=living-room&deviceName=Web%20TV
```

`lxc-dev` 需要能读到 NAS 曲库。当前通过 PVE bind mount 将宿主机 `/hdd-pool/nas` 只读挂载到容器 `/mnt/nas`：

```bash
pct set 102 -mp0 /hdd-pool/nas,mp=/mnt/nas,ro=1
```

容器内应能看到：

```bash
ls /mnt/nas/KTV歌曲
```

## 常用命令

```bash
bash deploy/docker/ktv.sh pull
bash deploy/docker/ktv.sh build
bash deploy/docker/ktv.sh start
bash deploy/docker/ktv.sh restart
bash deploy/docker/ktv.sh status
bash deploy/docker/ktv.sh doctor
bash deploy/docker/ktv.sh logs
bash deploy/docker/ktv.sh logs api
bash deploy/docker/ktv.sh probe-index -- --limit 300 --concurrency 2
bash deploy/docker/ktv.sh tag-styles-export -- --out /data/home-ktv-media/tagging/full/songs.jsonl
bash deploy/docker/ktv.sh tag-styles-jsonl -- --input /data/home-ktv-media/tagging/full/songs.jsonl --output /data/home-ktv-media/tagging/full/results.jsonl --source netease
bash deploy/docker/ktv.sh tag-styles-import -- --input /data/home-ktv-media/tagging/full/results.jsonl --dry-run
bash deploy/docker/ktv.sh stop
```

## 服务

```text
postgres    PostgreSQL 数据库
api         Fastify API，端口 4000
admin       Nginx 托管后台，端口 5174
controller  Nginx 托管手机控制器，端口 5176
tv-web      Nginx 托管 Web TV 调试端，端口 5173
```

API 容器启动时会先执行数据库迁移，再启动 `apps/api/dist/server.js`，避免线上运行时出现数据库字段缺失。

## 媒体路径

Docker 容器内的媒体根目录默认是：

```bash
DOCKER_MEDIA_ROOT=/data/home-ktv-media
```

NAS 在宿主机上的路径：

```bash
KTV_NAS_HOST_PATH=/mnt/nas/KTV歌曲
```

索引路径到容器路径的映射：

```bash
DOCKER_MEDIA_PATH_MAPPINGS=/mnt/nas/KTV歌曲=/nas/KTV歌曲
```

如果服务器 NAS 挂载路径和数据库索引路径一致，也仍然建议通过 `DOCKER_MEDIA_PATH_MAPPINGS` 明确映射到容器内路径。

## 验证

```bash
bash deploy/docker/ktv.sh config
bash deploy/docker/ktv.sh doctor
curl http://<server-ip>:4000/health
```

打开：

```text
http://<server-ip>:5174/
http://<server-ip>:5176/controller?room=living-room
http://<server-ip>:5173/?apiBaseUrl=http://<server-ip>:4000&roomSlug=living-room&deviceName=Web%20TV
```
