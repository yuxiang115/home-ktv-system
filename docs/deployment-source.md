# 源码部署

源码部署是当前私有测试服务器的推荐方式，适合服务器已经安装 Node.js 和 pnpm，并希望直接运行构建后的 Node/Vite 进程。高频测试时，它比 Docker Compose 少一次镜像构建，调试反馈更快。

源码部署不启动 PostgreSQL。数据库可以是宿主机 PostgreSQL，也可以继续由 Docker 提供；只要 `deploy/source/.env` 里的 `DATABASE_URL` 对源码进程可达即可。

## 系统依赖

源码部署主机需要安装：

```bash
apt-get install -y ffmpeg
```

`probe-index` 会调用 `ffprobe` 读取 NAS 歌曲的音轨和媒体信息。缺少 `ffprobe` 时，歌曲会被标记为 `technical_status = 'failed'`，需要安装依赖后使用 `--retry-failed` 重新探测。

## 第一次部署

```bash
git clone git@github.com:ShaoLongFei/home-ktv-system.git
cd home-ktv-system

bash deploy/source/ktv.sh setup
vim deploy/source/.env
bash deploy/source/ktv.sh deploy
bash deploy/source/ktv.sh status
```

`setup` 会执行：

```text
创建 deploy/source/.env
创建 runtime/logs、runtime/pids 和 MEDIA_ROOT 目录
```

`deploy` 会执行 `git pull --ff-only`、`pnpm install --frozen-lockfile`、`pnpm build`、数据库迁移、服务重启、doctor 和公开入口 smoke。

如果之后 `.env` 里的 `PUBLIC_BASE_URL` 或 `CONTROLLER_BASE_URL` 改了，重新运行：

```bash
bash deploy/source/ktv.sh deploy
```

## 常用命令

```bash
bash deploy/source/ktv.sh pull
bash deploy/source/ktv.sh deploy
bash deploy/source/ktv.sh build
bash deploy/source/ktv.sh migrate
bash deploy/source/ktv.sh start
bash deploy/source/ktv.sh restart
bash deploy/source/ktv.sh status
bash deploy/source/ktv.sh doctor
bash deploy/source/ktv.sh smoke
bash deploy/source/ktv.sh logs
bash deploy/source/ktv.sh logs api
bash deploy/source/ktv.sh probe-index -- --limit 300 --concurrency 2
bash deploy/source/ktv.sh cover-status
bash deploy/source/ktv.sh cover-coverage -- --limit 100
bash deploy/source/ktv.sh fetch-covers -- --limit 300
python3 scripts/tools/run_style_tagging_llm_batch.py status --env-file deploy/source/.env --output runtime/tagging/llm/llm-style-tags.jsonl
python3 scripts/tools/run_style_tagging_llm_batch.py run --env-file deploy/source/.env --max-existing-tags 1 --batch-size 30 --output runtime/tagging/llm/llm-style-tags.jsonl
python3 scripts/tools/run_style_tagging_llm_batch.py import --env-file deploy/source/.env --output runtime/tagging/llm/llm-style-tags.jsonl --dry-run
python3 scripts/tools/run_style_tagging_llm_batch.py import --env-file deploy/source/.env --output runtime/tagging/llm/llm-style-tags.jsonl --apply
bash deploy/source/ktv.sh stop
```

## 服务

```text
api         node apps/api/dist/server.js，端口 4000
admin       vite preview，端口 5174
controller  vite preview，端口 5176
tv-web      vite preview，端口 5173
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
ADMIN_BASE_URL=http://<server-ip>:5174
CONTROLLER_BASE_URL=http://<server-ip>:5176
TV_WEB_BASE_URL=http://<server-ip>:5173
CORS_ALLOWED_ORIGINS=http://<server-ip>:5174,http://<server-ip>:5176,http://<server-ip>:5173
MEDIA_ROOT=./runtime/media
MEDIA_PATH_MAPPINGS=/mnt/nas/KTV歌曲=/mnt/nas/KTV歌曲
TV_ROOM_SLUG=living-room
```

`PUBLIC_BASE_URL` 会在构建 Admin/Controller 时写入前端产物。如果服务器 IP 或域名变化，需要重新 `build`。

如果 PostgreSQL 仍由旧 Docker Compose 提供，可以只保留数据库容器，并停止旧的 API/Admin/Controller/Web TV 容器释放端口。源码部署读取的是 `MEDIA_PATH_MAPPINGS`，不要继续只配置 `DOCKER_MEDIA_PATH_MAPPINGS`。

## 验证

```bash
curl http://<server-ip>:4000/health
bash deploy/source/ktv.sh status
bash deploy/source/ktv.sh doctor
bash deploy/source/ktv.sh smoke
```

打开：

```text
http://<server-ip>:5174/
http://<server-ip>:5176/controller
http://<server-ip>:5173/
```
