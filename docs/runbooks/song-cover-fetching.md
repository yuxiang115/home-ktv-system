# 歌曲封面缓存 Runbook

## 目标

控制端首页推荐列表需要展示歌曲封面。封面不能在首页请求时实时查询外部音乐平台，而是通过后台脚本提前批量拉取、下载到本地缓存，再把公开图片地址写回 `ktv_songs.cover_image_url`。

当前实现只服务 NAS 曲库。线上曲库以后接入时，可以复用同一套缓存目录和公开路由，再扩展脚本筛选条件。

## 网易云 API 内部服务

`lxc-dev` 上已经部署 `NeteaseCloudMusicApiBackup` 作为内部查询服务，只用于后台脚本补封面和元数据，不对公网开放。

```text
代码目录：/opt/netease-cloud-music-api-backup
systemd：netease-cloud-music-api.service
监听地址：http://127.0.0.1:4300
```

常用检查：

```bash
systemctl status netease-cloud-music-api.service
curl 'http://127.0.0.1:4300/cloudsearch?keywords=刀郎%20冲动的惩罚&type=1&limit=1'
```

单首歌封面探测：

```bash
python3 scripts/tools/query_netease_cover.py 冲动的惩罚 刀郎 --base-url http://127.0.0.1:4300
```

该脚本只查询并输出候选封面 URL，不写数据库、不下载图片。正式批量缓存仍由 `fetch_song_covers.py` 负责。

## 当前实现

核心代码：

```text
scripts/tools/fetch_song_covers.py
scripts/tools/fetch_song_covers_test.py
scripts/tools/query_netease_cover.py
apps/api/src/routes/media.ts
apps/api/src/modules/covers/song-cover-repository.ts
```

缓存路径：

```text
$MEDIA_ROOT/covers/nas/<song-id>.jpg
```

公开 URL：

```text
$PUBLIC_BASE_URL/media/covers/nas/<song-id>.jpg
```

API 路由：

```text
GET /media/covers/nas/<song-id>.jpg
```

数据库只保存展示需要的两个字段：

```text
ktv_songs.cover_image_url
ktv_songs.cover_updated_at
```

`PUBLIC_BASE_URL` 必须配置为 API 地址，例如 `http://<server-ip>:4000`。控制端会直接使用 `coverImageUrl` 作为图片地址，如果写成相对路径，浏览器会请求到控制端自己的端口。

## 当前覆盖情况

截至 2026-06-01，`lxc-dev` 已跑完一次全量封面拉取：

```text
activeSongs=34385
withCoverUrl=3635
withoutCoverUrl=30750
```

这次全量脚本正常完成，失败只有少量网络错误；低覆盖率主要来自当前匹配策略偏保守。脚本要求歌名和歌手都匹配，provider 为 `tencent,kugou,kuwo`。下一轮提高覆盖率时，优先考虑把已经部署的网易云 API 接入 `fetch_song_covers.py`，或者增加本地视频首帧兜底。

## song-id 稳定性

`ktv_songs.id` 是主键，默认由 PostgreSQL `gen_random_uuid()` 生成。正常索引 NAS 曲库时，代码按 `file_path` 做 upsert：同一个文件再次扫描会更新原来的歌曲行，并保留原来的 `id`。

删除或下架 NAS 文件时，索引流程会把歌曲标记为 `missing_at`，不会改变其它歌曲的 `id`。如果手工把某首歌的数据库行彻底删掉，再重新扫描同一个文件，它会拿到新的 `id`；其它歌曲仍然不受影响，旧的封面缓存文件只会变成孤儿文件。

## 拉取逻辑

1. 从 `ktv_songs` 读取 `missing_at is null`、歌名和歌手都不为空的 NAS 歌曲。
2. 默认优先处理 `cover_updated_at is null` 或更早处理过的歌曲。
3. 如果本地已经有 `$MEDIA_ROOT/covers/nas/<song-id>.jpg`，但数据库 URL 不一致，脚本只修复 `cover_image_url`。
4. 如果 `cover_image_url` 里已有外部图片 URL，脚本会先尝试下载这个外链。
5. 没有可用外链时，按 provider 顺序查询封面：

```text
tencent -> kugou -> kuwo
```

6. 用歌名和歌手计算匹配分，拒绝弱匹配，并降低 DJ、Live、Remix、翻唱、现场等版本的分数。
7. 命中后下载图片到本地缓存，再写入本地公开 URL。
8. 未命中或失败时不写 `cover_image_url`，只更新 `cover_updated_at` 并写入进度文件。

## 进度文件

默认进度目录：

```text
$MEDIA_ROOT/covers/_jobs/
```

默认文件：

```text
song-covers.jsonl
song-covers.jsonl.state.json
```

`song-covers.jsonl` 是追加日志，每首歌一行，记录 `found`、`repaired`、`not_found`、`failed`、`skipped` 等状态。脚本重复运行时会读取这个文件，默认跳过已经失败或未命中过的歌曲，避免每次从头重试。

`song-covers.jsonl.state.json` 是当前批次状态，方便中途查看进度。

## 常用命令

源码部署推荐使用 wrapper，它会读取 `deploy/source/.env`：

```bash
bash deploy/source/ktv.sh cover-status
bash deploy/source/ktv.sh cover-coverage -- --limit 100 --concurrency 4 --delay-ms 200
bash deploy/source/ktv.sh fetch-covers -- --limit 300 --concurrency 4 --delay-ms 200
```

Docker 部署：

```bash
bash deploy/docker/ktv.sh cover-status
bash deploy/docker/ktv.sh cover-coverage -- --limit 100 --concurrency 4 --delay-ms 200
bash deploy/docker/ktv.sh fetch-covers -- --limit 300 --concurrency 4 --delay-ms 200
```

本机直接运行：

```bash
pnpm covers:status
pnpm covers:coverage -- --limit 100 --delay-ms 300
pnpm covers:songs -- --limit 300 --delay-ms 300
```

## 参数

```text
--limit <n>                 处理数量；0 表示全部，fetch 默认 0，coverage 默认 100
--providers <list>          provider 顺序，默认 tencent,kugou,kuwo
--search-limit <n>          每个 provider 搜索结果数，默认 8
--request-timeout-ms <n>    单次请求超时，默认 8000
--delay-ms <n>              每首歌之间的延迟，默认 600
--concurrency <n>           并发处理数量，默认 1；建议从 3 到 4 开始
--progress-every <n>        进度输出间隔，默认 20
--retry-failed              重新处理上次 failed 的歌曲
--retry-not-found           重新处理上次 not_found 的歌曲
--force                     忽略本地缓存和历史记录，强制重新查询并覆盖缓存
--media-root <path>         覆盖 MEDIA_ROOT
--cover-root <path>         覆盖封面缓存根目录，默认 MEDIA_ROOT/covers
--public-base-url <url>     覆盖 PUBLIC_BASE_URL
--output <path>             覆盖 JSONL 进度文件
--state <path>              覆盖 state 文件
```

## 重跑策略

日常补图：

```bash
bash deploy/source/ktv.sh fetch-covers -- --limit 300 --concurrency 4 --delay-ms 200
```

重试网络失败：

```bash
bash deploy/source/ktv.sh fetch-covers -- --retry-failed --limit 300 --concurrency 3 --delay-ms 300
```

重试没有找到封面的歌曲：

```bash
bash deploy/source/ktv.sh fetch-covers -- --retry-not-found --limit 300 --concurrency 3 --delay-ms 300
```

重新拉取一批并覆盖本地缓存：

```bash
bash deploy/source/ktv.sh fetch-covers -- --force --limit 300 --concurrency 2 --delay-ms 500
```

## 验证

查看数据库覆盖情况：

```bash
bash deploy/source/ktv.sh cover-status
```

检查 discovery 是否返回封面：

```bash
curl -sS "$PUBLIC_BASE_URL/rooms/living-room/songs/discovery?seed=cover-check&limit=30" \
  | jq '{recommended: (.recommended|length), covers: ([.recommended[] | select(.coverImageUrl != null)] | length), sample: [.recommended[] | select(.coverImageUrl != null) | {title, artistName, coverImageUrl}] | .[0:5]}'
```

抽查本地图片是否可访问：

```bash
curl -I "$PUBLIC_BASE_URL/media/covers/nas/<song-id>.jpg"
```
