# 封面字段合并设计

## 背景

当前曲库已经压缩到 `ktv_songs` 单表为核心。`song_cover_cache` 仍然是一张独立业务表，用来保存封面查询状态、provider 元数据、置信度和错误信息。家庭自用场景下，这些调试信息价值有限，运行时真正需要的是一个可展示的封面图片地址。

## 设计选择

采用最小字段方案：把封面展示地址合并到 `ktv_songs`，删除 `song_cover_cache`。

`ktv_songs` 新增字段：

- `cover_image_url text`：控制端展示的封面图片地址，可以是外部图片 URL，也可以是后续本地缓存文件的公开 URL。
- `cover_updated_at timestamptz`：最近一次封面处理时间。找到封面、没找到封面、查询失败都会更新时间，避免脚本无限重复处理同一批歌曲。

不保留：

- provider
- provider_song_id
- provider_payload
- confidence
- status
- error_message

原因是当前目标不是审核封面匹配质量，而是“尽量批量补图，有图就展示，没有以后再跑脚本”。

## 数据迁移

新增迁移 `0022_merge_song_cover_cache_into_ktv_songs.sql`：

1. 给 `ktv_songs` 增加 `cover_image_url` 和 `cover_updated_at`。
2. 从 `song_cover_cache` 迁移 NAS 已命中的封面：
   - `source_kind = 'nas'`
   - `status = 'found'`
   - `image_url is not null`
   - `source_song_id = ktv_songs.id`
3. `cover_updated_at` 优先使用 `fetched_at`，其次 `updated_at`，最后 `now()`。
4. 删除 `song_cover_cache`。

## 运行时变化

- 首页推荐、歌手详情和风格详情仍然返回 `coverImageUrl`，前端协议不变。
- 封面仓储不再读写 `song_cover_cache`，而是直接读写 `ktv_songs.cover_image_url`。
- 封面拉取脚本默认只处理 NAS 歌曲；`--source online` 暂时返回 0 个候选。
- `--retry-failed` 改为“重新处理已处理但仍没有封面的歌曲”，用于换 provider 或重试网络问题。

## 回滚

这次迁移会删除 `song_cover_cache`。如果迁移后发现严重问题，使用迁移前数据库备份回滚；不提供自动 down migration。
