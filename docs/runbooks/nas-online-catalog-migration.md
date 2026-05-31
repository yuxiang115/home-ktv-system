# 曲库最小化迁移 Runbook

## 目标

本次迁移在之前 NAS/Online 曲库重构的基础上继续压缩表结构：

```text
NAS:    ktv_songs
Online: candidate_tasks
```

关键变化：

- NAS 曲库只保留 `ktv_songs` 一张业务表。
- 一条 `ktv_songs` 就是一个 NAS 可播放文件。
- 歌手列表保存到 `ktv_songs.artist_names text[]`。
- 风格标签保存到 `ktv_songs.style_tags text[]`。
- 封面展示地址保存到 `ktv_songs.cover_image_url`。
- 线上歌曲和线上资源占位表删除，候选 ready 结果直接保存到 `candidate_tasks`。
- NAS 队列仍保留 `nas_song_id` 和 `nas_asset_id` 两个字段，但两者必须相等，并且都指向同一条 `ktv_songs.id`。

完整字段说明见 [../database-schema.md](../database-schema.md)。

## 影响范围

- 点歌、队列和播放直接使用 `ktv_songs.id`。
- 播放仍使用 `/media/nas/:assetId`，但这里的 `assetId` 实际就是 `ktv_songs.id`。
- 搜索、歌手分类和风格分类都只查 `ktv_songs`。
- 旧 NAS 维表和线上占位表会被删除。
- 这次迁移不保留 down migration；回滚需要恢复迁移前数据库备份。

## 迁移前备份

源码部署环境：

```bash
mkdir -p runtime/backups
pg_dump "$DATABASE_URL" --format=custom --file=runtime/backups/home_ktv_before_catalog_simplification.dump
```

Docker 部署环境：

```bash
mkdir -p runtime/backups

docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yml exec -T postgres \
  pg_dump -U ktv -d home_ktv --format=custom --file=/tmp/home_ktv_before_catalog_simplification.dump

docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yml cp \
  postgres:/tmp/home_ktv_before_catalog_simplification.dump \
  runtime/backups/home_ktv_before_catalog_simplification.dump
```

## 迁移前检查

确认旧 NAS 曲库表有数据：

```sql
select
  (select count(*) from ktv_songs) as ktv_songs,
  (select count(*) from ktv_song_assets) as ktv_song_assets;
```

确认 NAS 队列都能映射到旧资源表：

```sql
select qe.id, qe.nas_song_id, qe.nas_asset_id
from queue_entries qe
left join ktv_song_assets asset
  on asset.id = qe.nas_asset_id
where qe.source_type = 'nas'
  and asset.id is null
limit 20;
```

期望无返回行。

如果迁移前仍有旧封面缓存表，可以确认封面缓存来源分布：

```sql
select source_kind, status, count(*)
from song_cover_cache
group by source_kind, status
order by source_kind, status;
```

## 部署和迁移

源码部署环境推荐：

```bash
bash deploy/source/ktv.sh deploy
```

如果需要手动执行迁移：

```bash
pnpm -F @home-ktv/api migrate
```

Docker 备用路径：

```bash
bash deploy/docker/ktv.sh start
```

API 启动时会自动执行数据库迁移。

## 迁移后数据库验证

业务表应只剩当前目标表：

```sql
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'rooms',
    'room_clients',
    'queue_entries',
    'ktv_songs',
    'candidate_tasks'
  )
order by table_name;
```

旧曲库表应被删除：

```sql
select
  to_regclass('public.ktv_song_assets') as ktv_song_assets,
  to_regclass('public.ktv_artists') as ktv_artists,
  to_regclass('public.ktv_song_artists') as ktv_song_artists,
  to_regclass('public.ktv_index_runs') as ktv_index_runs,
  to_regclass('public.ktv_song_style_tags') as ktv_song_style_tags,
  to_regclass('public.online_songs') as online_songs,
  to_regclass('public.online_song_assets') as online_song_assets,
  to_regclass('public.song_cover_cache') as song_cover_cache;
```

期望所有列都是 `NULL`。

NAS 队列应指向新的 `ktv_songs`：

```sql
select qe.id, qe.nas_song_id, qe.nas_asset_id
from queue_entries qe
left join ktv_songs song
  on song.id = qe.nas_song_id
where qe.source_type = 'nas'
  and (
    qe.nas_song_id is null
    or qe.nas_asset_id is null
    or qe.nas_song_id <> qe.nas_asset_id
    or song.id is null
  )
limit 20;
```

期望无返回行。

曲库可用数量：

```sql
select
  count(*) filter (where missing_at is null) as active_songs,
  count(*) filter (where missing_at is not null) as missing_songs,
  count(*) filter (where coalesce(array_length(artist_names, 1), 0) = 0) as songs_without_artist_array,
  count(*) filter (where coalesce(array_length(style_tags, 1), 0) = 0) as songs_without_style_tags,
  count(*) filter (where cover_image_url is not null) as songs_with_cover
from ktv_songs;
```

`songs_without_style_tags` 不一定为 0，因为标签可以后续由独立脚本补齐。

## 接口冒烟

服务检查：

```bash
bash deploy/source/ktv.sh doctor
curl -sS 'https://ktv-api.shaolongfei.com/health'
```

发现页应返回 NAS 歌曲：

```bash
curl -sS 'https://ktv-api.shaolongfei.com/rooms/living-room/songs/discovery?limit=5' \
  | jq '{recommended: [.recommended[] | {title, artistName, versions: [.versions[] | {sourceType, assetId}]}]}'
```

期望 `versions[].sourceType` 为 `nas`，并且 `versions[].assetId` 能在 `ktv_songs.id` 中找到。

找一个真实 `assetId` 后验证媒体流：

```bash
curl -I -H 'Range: bytes=0-1023' 'https://ktv-api.shaolongfei.com/media/nas/<asset-id>'
```

期望返回 `206 Partial Content` 或可接受的媒体响应头。

控制端和 TV 冒烟：

```text
Controller: https://ktv-controller.shaolongfei.com/controller?room=living-room&token=<control-token>
Web TV:     https://ktv-tv.shaolongfei.com/?apiBaseUrl=https://ktv-api.shaolongfei.com&roomSlug=living-room&deviceName=Web%20TV
```

验证点：

- TV 不显示离线。
- 控制端首页推荐列表加载真实 NAS 歌曲。
- 点击推荐歌曲的加号后，控制 tab 红色气泡立即刷新。
- 控制 tab 播放列表出现刚点的歌曲。
- TV 收到播放目标并能播放。
- 播放结束、失败、切歌 telemetry 不因为缺少 `sourceType` 被拒绝。

## 回滚

这次迁移会删除旧曲库维表和线上占位表，不提供自动反向迁移。回滚步骤：

1. 停止 API。
2. 恢复迁移前的 PostgreSQL 备份。
3. 回退代码版本。
4. 启动服务并执行接口冒烟。
