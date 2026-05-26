# 源码部署

源码部署适合服务器已经安装 Node.js、pnpm、PostgreSQL，并希望直接运行构建后的 Node/Vite 进程。

## 第一次部署

```bash
git clone git@github.com:ShaoLongFei/home-ktv-system.git
cd home-ktv-system

bash deploy/source/ktv.sh setup
vim deploy/source/.env
bash deploy/source/ktv.sh build
bash deploy/source/ktv.sh restart
bash deploy/source/ktv.sh status
```

`setup` 会执行：

```text
pnpm install --frozen-lockfile
pnpm build
pnpm db:migrate
```

如果之后 `.env` 里的 `PUBLIC_BASE_URL` 或 `CONTROLLER_BASE_URL` 改了，重新运行：

```bash
bash deploy/source/ktv.sh build
bash deploy/source/ktv.sh restart
```

## 常用命令

```bash
bash deploy/source/ktv.sh pull
bash deploy/source/ktv.sh build
bash deploy/source/ktv.sh migrate
bash deploy/source/ktv.sh start
bash deploy/source/ktv.sh restart
bash deploy/source/ktv.sh status
bash deploy/source/ktv.sh logs
bash deploy/source/ktv.sh logs api
bash deploy/source/ktv.sh stop
```

## 服务

```text
api         node apps/api/dist/server.js，端口 4000
admin       vite preview，端口 5174
controller  vite preview，端口 5176
```

日志和 PID：

```text
runtime/logs/
runtime/pids/
```

## 关键环境变量

```bash
DATABASE_URL=postgres://ktv:ktv@127.0.0.1:5432/home_ktv
PUBLIC_BASE_URL=http://<server-ip>:4000
CONTROLLER_BASE_URL=http://<server-ip>:5176
CORS_ALLOWED_ORIGINS=http://<server-ip>:5174,http://<server-ip>:5176
MEDIA_ROOT=./runtime/media
MEDIA_PATH_MAPPINGS=/mnt/nas/KTV歌曲=/mnt/nas/KTV歌曲
TV_ROOM_SLUG=living-room
```

`PUBLIC_BASE_URL` 会在构建 Admin/Controller 时写入前端产物。如果服务器 IP 或域名变化，需要重新 `build`。

## 验证

```bash
curl http://<server-ip>:4000/health
bash deploy/source/ktv.sh status
```

打开：

```text
http://<server-ip>:5174/
http://<server-ip>:5176/controller?room=living-room
```
