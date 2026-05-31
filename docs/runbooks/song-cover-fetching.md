# 歌曲封面拉取 Runbook

## 目标

控制端首页推荐列表需要展示歌曲封面。封面不应在首页请求时实时查询外部音乐平台，而应通过后台批量任务提前拉取并缓存结果，首页只读取缓存字段。

当前实现已经完成：

- 使用国内音乐源查询封面：腾讯、酷狗、网易云、酷我。
- 用歌名和歌手做匹配，拒绝弱匹配，并降低 Live、DJ、Remix、翻唱、现场等版本的得分。
- 将查询结果写入 `ktv_songs.cover_image_url`。
- `GET /rooms/:roomSlug/songs/discovery` 只读取歌曲行上的封面地址并返回 `coverImageUrl`。
- 控制端推荐列表优先展示 `coverImageUrl`，图片失败时回退到本地生成样式。

当前实现尚未完成：

- 还没有把外部图片下载到本地文件缓存。
- 目前 `cover_image_url` 存的是外部平台图片地址。

后续如果要把封面文件落地到本地缓存，可以继续沿用 `ktv_songs` 的这两个字段：

- `cover_image_url`：返回给前端的公开地址。
- `cover_updated_at`：最近一次封面处理时间。

## 代码位置

```text
apps/api/src/modules/covers/meting-cover-provider.ts
apps/api/src/modules/covers/cover-matcher.ts
apps/api/src/modules/covers/cover-backfill-service.ts
apps/api/src/modules/covers/song-cover-repository.ts
apps/api/src/scripts/song-covers.ts
apps/api/src/scripts/song-cover-coverage.ts
apps/api/src/db/migrations/0022_merge_song_cover_cache_into_ktv_songs.sql
deploy/docker/ktv.sh
```

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
cover_image_url
cover_updated_at
```

8. 没有可靠匹配时，保留 `cover_image_url = NULL`，只更新 `cover_updated_at`。

```text
cover_image_url = null
cover_updated_at
```

9. provider 网络错误或接口异常时，同样保留 `cover_image_url = NULL`，只更新 `cover_updated_at`。

```text
cover_image_url = null
cover_updated_at
```

## 覆盖率测试

覆盖率测试只读数据库，不写 `ktv_songs`。

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

## 批量写入封面地址

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

重试已经处理过但仍没有封面的歌曲：

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
  -c "SELECT count(*) FILTER (WHERE cover_image_url IS NOT NULL) AS covered,
             count(*) FILTER (WHERE cover_image_url IS NULL) AS uncovered
        FROM ktv_songs;"
```

检查 discovery 是否返回封面：

```bash
curl -sS 'https://ktv-api.shaolongfei.com/rooms/living-room/songs/discovery?seed=cover-check&limit=30' \
  | jq '{recommended: (.recommended|length), covers: ([.recommended[] | select(.coverImageUrl != null)] | length), sample: [.recommended[] | select(.coverImageUrl != null) | {title, artistName, coverImageUrl}] | .[0:5]}'
```
