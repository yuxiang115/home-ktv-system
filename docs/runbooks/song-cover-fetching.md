# 歌曲封面拉取 Runbook

## 目标

控制端首页推荐列表需要展示歌曲封面。封面不应在首页请求时实时查询外部音乐平台，而应通过后台批量任务提前拉取并缓存结果，首页只读取缓存字段。

当前实现已经完成：

- 使用国内音乐源查询封面：腾讯、酷狗、网易云、酷我。
- 用歌名和歌手做匹配，拒绝弱匹配，并降低 Live、DJ、Remix、翻唱、现场等版本的得分。
- 将查询结果写入 `song_cover_cache`。
- `GET /rooms/:roomSlug/songs/discovery` 只读取 `song_cover_cache.image_url` 并返回 `coverImageUrl`。
- 控制端推荐列表优先展示 `coverImageUrl`，图片失败时回退到本地生成样式。

当前实现尚未完成：

- 还没有把外部图片下载到本地文件缓存。
- 目前 `image_url` 存的是外部平台图片地址。

后续本地图片缓存应继续扩展 `song_cover_cache`，不要把封面字段放入 `ktv_songs` 主表。

## 代码位置

```text
apps/api/src/modules/covers/meting-cover-provider.ts
apps/api/src/modules/covers/cover-matcher.ts
apps/api/src/modules/covers/cover-backfill-service.ts
apps/api/src/modules/covers/song-cover-cache-repository.ts
apps/api/src/scripts/song-covers.ts
apps/api/src/scripts/song-cover-coverage.ts
apps/api/src/db/migrations/0016_song_cover_cache.sql
deploy/docker/ktv.sh
```

## 数据表

`song_cover_cache` 当前字段：

```text
source_kind            nas | online
source_song_id         ktv_songs.id 或后续 online 歌曲 ID
title
artist_name
normalized_title
normalized_artist_name
provider
provider_song_id
provider_payload
image_url
status                 pending | found | not_found | failed
confidence
error_message
fetched_at
created_at
updated_at
```

当前真实曲库主要使用：

```text
source_kind = 'nas'
source_song_id = ktv_songs.id
```

说明：物理 NAS 索引当前只保留 `ktv_songs` 单表；`source_kind` 是运行时和 API 层的来源语义，统一使用 `nas` / `online`。

## 拉取逻辑

1. 从数据库抽取待处理歌曲。
2. 默认优先处理 `nas` 真实曲库。
3. 对每首歌按 provider 顺序查询：

```text
tencent -> kugou -> netease -> kuwo
```

4. 查询关键词：

```text
artistName + " " + title
```

5. 对搜索结果计算置信度：

- 歌名必须命中或近似命中。
- 歌手必须命中或近似命中。
- Live、DJ、Remix、翻唱、现场、演唱会等候选会降权。
- 置信度低于阈值的候选会被拒绝。

6. 取最佳候选的 `pic_id` 并调用 `pic(pic_id, 300)`。
7. 成功时写入：

```text
status = found
provider
provider_song_id
provider_payload
image_url
confidence
fetched_at
```

8. 没有可靠匹配时写入：

```text
status = not_found
error_message = "No reliable cover match found"
```

9. provider 网络错误或接口异常时写入：

```text
status = failed
error_message
```

## 覆盖率测试

覆盖率测试只读数据库，不写 `song_cover_cache`。

本地源码环境：

```bash
DATABASE_URL=postgres://ktv:ktv@127.0.0.1:5432/home_ktv \
pnpm covers:coverage -- --limit 100 --delay-ms 250
```

Docker 部署环境：

```bash
bash deploy/docker/ktv.sh cover-coverage -- --limit 100 --delay-ms 250
```

常用参数：

```text
--limit <n>                 抽样数量，默认 100
--source <nas|online>        默认 nas
--delay-ms <n>              每首歌之间的延迟，默认 250
--providers <list>          默认 tencent,kugou,netease,kuwo
--progress-every <n>        进度输出间隔，默认 20
--search-limit <n>          每个 provider 搜索结果数，默认 8
--request-timeout-ms <n>    单次 provider 请求超时，默认 6000
```

2026-05-28 在 `lxc-dev` 真实曲库上测试：

```text
sample=100
found=92
not_found=8
failed=0
hitRate=92.0%
avgConfidence=98.8
avgMs=2530
p95Ms=3838
providerHits: tencent=78, kugou=13, netease=1
```

另一次长样本跑到 120 首时命中 114 首，阶段性命中率为 95.0%。该长测没有完整 summary，正式结论以 100 首完整测试为准。

## 批量写入缓存

本地源码环境：

```bash
DATABASE_URL=postgres://ktv:ktv@127.0.0.1:5432/home_ktv \
pnpm covers:songs -- --limit 300 --delay-ms 300
```

Docker 部署环境：

```bash
bash deploy/docker/ktv.sh fetch-covers -- --limit 300 --delay-ms 300
```

只处理 NAS 真实曲库：

```bash
bash deploy/docker/ktv.sh fetch-covers -- --source nas --limit 300 --delay-ms 300
```

重试网络失败：

```bash
bash deploy/docker/ktv.sh fetch-covers -- --retry-failed --limit 300 --delay-ms 300
```

指定 provider 顺序：

```bash
bash deploy/docker/ktv.sh fetch-covers -- \
  --providers tencent,kugou,netease,kuwo \
  --limit 300 \
  --delay-ms 300
```

首次测试建议先跑 300 首。确认没有明显限流或异常后，再分批跑 1000 首：

```bash
bash deploy/docker/ktv.sh fetch-covers -- --source nas --limit 1000 --delay-ms 300
```

不要在首页接口里实时调用外部音乐源。

## 查询进度

```bash
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yml exec -T postgres \
  psql -U ktv -d home_ktv \
  -c "SELECT source_kind, status, count(*) FROM song_cover_cache GROUP BY source_kind, status ORDER BY source_kind, status;"
```

按 provider 统计：

```bash
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yml exec -T postgres \
  psql -U ktv -d home_ktv \
  -c "SELECT provider, count(*) FROM song_cover_cache WHERE status = 'found' GROUP BY provider ORDER BY count(*) DESC;"
```

检查 discovery 是否返回封面：

```bash
curl -sS 'https://ktv-api.shaolongfei.com/rooms/living-room/songs/discovery?seed=cover-check&limit=30' \
  | jq '{recommended: (.recommended|length), covers: ([.recommended[] | select(.coverImageUrl != null)] | length), sample: [.recommended[] | select(.coverImageUrl != null) | {title, artistName, coverImageUrl}] | .[0:5]}'
```

## 本地图片缓存方案

下一步应把外部图片下载到持久化目录，例如：

```text
/data/home-ktv-media/covers/nas/<song-id>.jpg
```

API 对外暴露：

```text
https://ktv-api.shaolongfei.com/covers/nas/<song-id>.jpg
```

建议给 `song_cover_cache` 增加字段：

```sql
ALTER TABLE song_cover_cache
  ADD COLUMN external_image_url text,
  ADD COLUMN local_image_path text,
  ADD COLUMN image_content_type text,
  ADD COLUMN image_size_bytes bigint,
  ADD COLUMN downloaded_at timestamptz;
```

字段职责：

```text
external_image_url     外部平台返回的原图地址
local_image_path       本地持久化文件相对路径
image_url              返回给前端的公开 URL
image_content_type     image/jpeg 等
image_size_bytes       下载后的文件大小
downloaded_at          下载成功时间
```

落地后，`status = found` 应表示“已经找到并已缓存到本地”。如果只查到外链但下载失败，应保留 `external_image_url` 并把状态记为 `failed`，后续通过 `--retry-failed` 重试。
