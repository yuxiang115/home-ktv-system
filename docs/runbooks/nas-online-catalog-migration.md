# NAS/Online 曲库重构迁移 Runbook

## 目标

本次迁移删除旧的 `songs` / `assets` / `source_records` 桥接层，点歌、队列和播放直接使用：

```text
NAS:    ktv_songs / ktv_song_assets
Online: online_songs / online_song_assets
```

当前线上歌曲来源只有 NAS；online 表只作为后续扩展占位。

## 影响范围

- 旧 import/admission 流程退役。
- `/admin/catalog/*`、`/admin/import*`、`/rooms/:roomSlug/available-songs` 不再作为运行时接口。
- 控制端使用 `/rooms/:roomSlug/songs/search`、`/rooms/:roomSlug/songs/discovery` 和 `sourceType + assetId` 点歌。
- 播放使用 `/media/nas/:assetId` 直接读取 NAS 文件。
- `/media/ktv-index/:indexedAssetId/raw` 只保留给后台诊断。

## 迁移前备份

Docker 部署环境：

```bash
mkdir -p runtime/backups

docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yml exec -T postgres \
  pg_dump -U ktv -d home_ktv --format=custom --file=/tmp/home_ktv_before_nas_online_refactor.dump

docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yml cp \
  postgres:/tmp/home_ktv_before_nas_online_refactor.dump \
  runtime/backups/home_ktv_before_nas_online_refactor.dump
```

如果不是 Docker 部署，使用当前 `DATABASE_URL` 做同等备份：

```bash
pg_dump "$DATABASE_URL" --format=custom --file=runtime/backups/home_ktv_before_nas_online_refactor.dump
```

## 迁移前检查

确认 NAS 索引表有数据：

```bash
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yml exec -T postgres \
  psql -U ktv -d home_ktv \
  -c "SELECT (SELECT count(*) FROM ktv_songs) AS ktv_songs, (SELECT count(*) FROM ktv_song_assets) AS ktv_song_assets;"
```

确认旧队列中是否存在无法映射到 NAS 的条目：

```bash
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yml exec -T postgres \
  psql -U ktv -d home_ktv \
  -c "SELECT qe.id, qe.song_id, qe.asset_id, qe.status
        FROM queue_entries qe
        LEFT JOIN source_records sr
          ON sr.asset_id = qe.asset_id
         AND sr.provider = 'ktv-index'
        LEFT JOIN ktv_song_assets kta
          ON kta.id = COALESCE(sr.provider_item_id, regexp_replace(qe.asset_id, '^asset-ktv-', ''))
       WHERE qe.status IN ('queued', 'preparing', 'loading', 'playing')
         AND kta.id IS NULL
       LIMIT 20;"
```

如果这条 SQL 返回数据，`0017` 迁移会把这些不可映射队列归档到 `queue_entries_unmapped_archive`，并从有效队列中删除。后续 `0018` 迁移会删除这个归档表，但会先检查它是否为空；如果表内有数据，迁移会失败并要求人工检查。迁移前可以先清空队列或确认这些旧队列可以丢弃。

确认封面缓存来源分布：

```bash
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yml exec -T postgres \
  psql -U ktv -d home_ktv \
  -c "SELECT source_kind, status, count(*) FROM song_cover_cache GROUP BY source_kind, status ORDER BY source_kind, status;"
```

## 部署和迁移

推荐停机窗口内执行：

```bash
bash deploy/docker/ktv.sh stop
bash deploy/docker/ktv.sh pull
bash deploy/docker/ktv.sh build
bash deploy/docker/ktv.sh start
```

Docker API 容器启动时会自动执行数据库迁移。若需要手动执行迁移：

```bash
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yml exec -T api \
  pnpm -F @home-ktv/api migrate
```

## 迁移后数据库验证

旧桥接表应被删除：

```bash
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yml exec -T postgres \
  psql -U ktv -d home_ktv \
  -c "SELECT to_regclass('public.songs') AS songs_table,
             to_regclass('public.assets') AS assets_table,
             to_regclass('public.source_records') AS source_records_table;"
```

期望三列均为 `NULL`。

队列必须全部有明确来源：

```bash
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yml exec -T postgres \
  psql -U ktv -d home_ktv \
  -c "SELECT source_type, count(*) FROM queue_entries GROUP BY source_type ORDER BY source_type;"
```

NAS 队列条目应能关联回 `ktv_song_assets`：

```bash
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yml exec -T postgres \
  psql -U ktv -d home_ktv \
  -c "SELECT qe.id, qe.nas_asset_id
        FROM queue_entries qe
        LEFT JOIN ktv_song_assets kta
          ON kta.id = qe.nas_asset_id
         AND kta.song_id = qe.nas_song_id
       WHERE qe.source_type = 'nas'
         AND kta.id IS NULL
       LIMIT 20;"
```

期望无返回行。

封面来源只应剩下 `nas` / `online`：

```bash
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yml exec -T postgres \
  psql -U ktv -d home_ktv \
  -c "SELECT source_kind, count(*) FROM song_cover_cache GROUP BY source_kind ORDER BY source_kind;"
```

## 接口冒烟

服务检查：

```bash
bash deploy/docker/ktv.sh doctor
curl -sS 'https://ktv-api.shaolongfei.com/health'
```

发现页应返回 NAS 歌曲：

```bash
curl -sS 'https://ktv-api.shaolongfei.com/rooms/living-room/songs/discovery?limit=5' \
  | jq '{recommended: [.recommended[] | {title, artistName, source, versions: [.versions[] | {sourceType, assetId}]}]}'
```

期望 `source` 和 `versions[].sourceType` 为 `nas`。

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

本次迁移会删除旧桥接表，不提供把 `ktv_*` 反向恢复成 `songs/assets` 的 down migration。回滚必须使用迁移前备份。

```bash
bash deploy/docker/ktv.sh stop

docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yml up -d postgres

docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yml cp \
  runtime/backups/home_ktv_before_nas_online_refactor.dump \
  postgres:/tmp/home_ktv_before_nas_online_refactor.dump

docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yml exec -T postgres \
  dropdb -U ktv --if-exists home_ktv

docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yml exec -T postgres \
  createdb -U ktv home_ktv

docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yml exec -T postgres \
  pg_restore -U ktv -d home_ktv --clean --if-exists /tmp/home_ktv_before_nas_online_refactor.dump
```

恢复旧代码提交后重启：

```bash
git checkout <previous-good-commit>
bash deploy/docker/ktv.sh start
bash deploy/docker/ktv.sh doctor
```

回滚后重新确认控制端、TV 在线状态、队列和播放。
