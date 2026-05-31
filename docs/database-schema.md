# 数据库结构说明

最后更新：2026-05-31。

本文面向项目维护和结构讨论，描述 `apps/api/src/db/schema.ts` 与迁移 `0022_merge_song_cover_cache_into_ktv_songs.sql` 之后的目标结构。当前保留 5 张业务表；`schema_migrations` 是迁移工具表，不算业务表。

## 总体分组

```text
房间、控制与播放运行态
rooms
  -> room_clients
  -> queue_entries

NAS 曲库
ktv_songs
  -> queue_entries

线上候选工作流
candidate_tasks
```

## 表总览

| 表 | 用途 |
| --- | --- |
| `rooms` | 房间元信息、配对 token、房间级播放状态。 |
| `room_clients` | TV 端和控制端 session / 在线状态。 |
| `queue_entries` | 当前点歌队列和短期可撤销记录。 |
| `ktv_songs` | NAS 可播放歌曲文件。一个文件一行，同时保存歌手、风格、路径、技术探测、封面地址和长期点歌计数。 |
| `candidate_tasks` | 线上候选歌曲发现、拉取、审核和 ready 结果记录。当前只是候选工作流，不再依赖线上曲库占位表。 |

## 已删除的业务表

迁移 `0021_catalog_schema_simplification.sql` 和 `0022_merge_song_cover_cache_into_ktv_songs.sql` 会删除下面这些表：

| 旧表 | 删除原因 |
| --- | --- |
| `ktv_song_assets` | 合并进 `ktv_songs`。现在一条 `ktv_songs` 就是一个 NAS 可播放文件。 |
| `ktv_artists` | 合并进 `ktv_songs.artist_names`。当前规模下不需要单独歌手维表。 |
| `ktv_song_artists` | 合并进 `ktv_songs.artist_names`。多歌手用数组保存。 |
| `ktv_index_runs` | 不再保留索引任务历史表，`ktv_songs.first_seen_run_id` 和 `last_seen_run_id` 只保留文本批次号。 |
| `ktv_song_style_tags` | 合并进 `ktv_songs.style_tags`。多风格用数组保存。 |
| `online_songs` | 删除线上曲库占位表。当前没有真实线上曲库。 |
| `online_song_assets` | 删除线上资源占位表。候选 ready 结果直接存在 `candidate_tasks`。 |
| `song_cover_cache` | 合并进 `ktv_songs.cover_image_url`。当前只需要保存前端展示的封面图地址。 |

## 关系总览

### 房间与运行态

- `room_clients.room_id -> rooms.id`，`ON DELETE CASCADE`。
- `rooms.default_player_device_id -> room_clients.id`，`ON DELETE SET NULL`。
- `rooms.current_queue_entry_id -> queue_entries.id`，`ON DELETE SET NULL`。
- `rooms.next_queue_entry_id -> queue_entries.id`，`ON DELETE SET NULL`。
- `queue_entries.room_id -> rooms.id`，`ON DELETE CASCADE`。
- `queue_entries.removed_by_control_session_id -> room_clients.id`，`ON DELETE SET NULL`。

### NAS 曲库与队列

- `queue_entries.nas_song_id -> ktv_songs.id`，`ON DELETE RESTRICT`。
- NAS 队列要求 `nas_song_id = nas_asset_id`。这是兼容现有播放链路的过渡字段设计，因为现在歌曲 ID 和资源 ID 已经是同一个 ID。
- `queue_entries_source_identity_ck` 保证一条队列记录只属于 NAS 或线上其中一种来源。

### 线上候选

- `candidate_tasks.room_id -> rooms.id`，`ON DELETE CASCADE`。
- `candidate_tasks` 的 ready 结果直接保存到 `ready_asset_id`、`ready_media_url`、`ready_cache_path` 和 `ready_metadata`，不再外键到线上资源表。

## 迁移说明

### `0021_catalog_schema_simplification.sql`

这次迁移会做一次不可逆的曲库结构压缩：

1. 用旧 `ktv_song_assets + ktv_songs` 生成新的 `ktv_songs_minimal`。
2. 新 `ktv_songs.id = 旧 ktv_song_assets.id`，也就是用媒体文件 ID 作为新的歌曲 ID。
3. 歌名、主歌手、拼音、首字母、点歌计数从旧 `ktv_songs` 迁移。
4. 文件路径、文件名、扩展名、大小、mtime、解析置信度、技术探测、缺失状态从旧 `ktv_song_assets` 迁移。
5. 多歌手从旧 `ktv_song_artists + ktv_artists` 聚合到 `artist_names text[]`。
6. 多风格从旧 `ktv_song_style_tags` 聚合到 `style_tags text[]`。
7. NAS 封面缓存从旧逻辑歌曲 ID 复制到每个新文件歌曲 ID。
8. NAS 队列的 `nas_song_id` 改成 `nas_asset_id`，让队列指向新的 `ktv_songs.id`。
9. `candidate_tasks.ready_online_asset_id` 迁移为 `ready_asset_id`，并删除线上资源外键。
10. 删除旧 NAS 维表和线上占位表。

部署前需要备份数据库。如果迁移后发现严重问题，回滚方式是恢复数据库备份并回退代码版本。

### `0022_merge_song_cover_cache_into_ktv_songs.sql`

这次迁移会继续减少业务表数量：

1. 给 `ktv_songs` 增加 `cover_image_url` 和 `cover_updated_at`。
2. 把旧 `song_cover_cache` 中 `source_kind = 'nas'`、`status = 'found'`、`image_url is not null` 的记录迁移到 `ktv_songs.cover_image_url`。
3. 删除 `song_cover_cache`。

迁移后不再保存封面 provider、置信度、错误信息和原始 payload。封面拉取脚本只负责尽量给 `ktv_songs.cover_image_url` 补图。

## 字段清单

### `rooms`

房间表，同时保存配对信息和房间级播放状态。

| 字段 | 含义 |
| --- | --- |
| `id text` | 主键。默认房间为 `living-room`。 |
| `slug text` | 房间短标识，唯一。 |
| `name text` | 房间名称。 |
| `status text` | 房间状态：`active`、`inactive`、`maintenance`。 |
| `default_player_device_id text` | 默认或最近注册的 TV 客户端，外键到 `room_clients.id`。 |
| `pairing_token_value text` | 展示给控制端扫码或输入的配对 token。 |
| `pairing_token_hash text` | 配对 token 校验 hash。 |
| `pairing_token_expires_at timestamptz` | 配对 token 过期时间。 |
| `pairing_token_rotated_at timestamptz` | 配对 token 最近轮换时间。 |
| `current_queue_entry_id text` | 当前播放队列项。 |
| `target_vocal_mode text` | 目标声轨：`original`、`instrumental`、`dual`、`unknown`。 |
| `player_state text` | 播放器状态：`idle`、`preparing`、`loading`、`playing`、`paused`、`recovering`、`error`。 |
| `player_position_ms integer` | 播放位置，非负。 |
| `next_queue_entry_id text` | 下一首队列项。 |
| `playback_version integer` | 播放状态版本号。 |
| `volume_percent integer` | 房间音量，0 到 100。 |
| `media_started_at timestamptz` | 当前媒体开始播放时间。 |
| `playback_updated_at timestamptz` | 播放状态更新时间。 |
| `created_at timestamptz` | 创建时间。 |
| `updated_at timestamptz` | 房间元信息或配对信息更新时间。 |

### `room_clients`

统一保存 TV 端和控制端。

| 字段 | 含义 |
| --- | --- |
| `id text` | 主键。 |
| `room_id text` | 外键到 `rooms.id`。 |
| `client_type text` | 客户端类型：`tv` 或 `controller`。 |
| `device_id text` | 客户端设备 ID。 |
| `device_name text` | 客户端展示名。 |
| `last_seen_at timestamptz` | 最近心跳或会话刷新时间。 |
| `expires_at timestamptz` | 控制端 session 过期时间；控制端必填。 |
| `revoked_at timestamptz` | 撤销时间。 |
| `capabilities jsonb` | TV 能力或客户端能力。 |
| `pairing_token text` | TV 注册时使用的配对 token 快照。 |
| `created_at timestamptz` | 创建时间。 |
| `updated_at timestamptz` | 更新时间。 |

关键约束：

- `UNIQUE(room_id, client_type, device_id)`。
- 控制端必须有 `expires_at`。

### `queue_entries`

当前点歌队列表。它不承担长期点歌历史；长期统计在 `ktv_songs.request_count`。

| 字段 | 含义 |
| --- | --- |
| `id text` | 主键。 |
| `room_id text` | 外键到 `rooms.id`。 |
| `source_type text` | 来源：`nas` 或 `online`。 |
| `nas_song_id text` | NAS 歌曲 ID，外键到 `ktv_songs.id`。 |
| `nas_asset_id text` | NAS 资源 ID。当前为了兼容旧播放链路保留，NAS 下必须等于 `nas_song_id`。 |
| `online_song_id text` | 线上歌曲 ID。当前没有外键，只作为未来线上曲库占位字段。 |
| `online_asset_id text` | 线上资源 ID。当前没有外键，只作为未来线上曲库占位字段。 |
| `requested_by text` | 点歌来源或控制端标识。 |
| `queue_position integer` | 队列位置。 |
| `status text` | 状态：`queued`、`preparing`、`loading`、`playing`、`played`、`skipped`、`failed`、`removed`。 |
| `priority integer` | 优先级。 |
| `playback_options jsonb` | 偏好声轨、音调等播放选项。 |
| `requested_at timestamptz` | 点歌时间。 |
| `started_at timestamptz` | 开始播放时间。 |
| `ended_at timestamptz` | 结束时间。 |
| `removed_at timestamptz` | 删除时间。 |
| `removed_by_control_session_id text` | 删除操作的控制端客户端 ID。 |
| `undo_expires_at timestamptz` | 撤销删除截止时间。 |

### `ktv_songs`

NAS 曲库表。当前最重要的约定是：一条 `ktv_songs` 就是一个 NAS 可播放文件。如果同一首歌有多个版本或多个文件，它们会是多行。

| 字段 | 含义 |
| --- | --- |
| `id text` | 主键。迁移后来自旧 `ktv_song_assets.id`。 |
| `title text` | 歌名。 |
| `normalized_title text` | 归一化歌名，用于搜索和去重辅助。 |
| `title_pinyin text` | 歌名拼音。 |
| `title_initials text` | 歌名拼音首字母。 |
| `primary_artist_name text` | 主歌手名称。 |
| `normalized_primary_artist_name text` | 归一化主歌手名称。 |
| `artist_names text[]` | 歌手数组。多歌手直接存在数组里。 |
| `style_tags text[]` | 风格标签数组。一首歌多个标签时存成一个数组，例如 `{'流行','粤语','合唱'}`。 |
| `file_path text` | NAS 上的完整文件路径，唯一。 |
| `relative_path text` | 相对曲库根目录的路径。 |
| `file_name text` | 文件名。 |
| `extension text` | 文件扩展名。 |
| `size_bytes bigint` | 文件大小。 |
| `mtime_ms bigint` | 文件修改时间，毫秒时间戳。 |
| `parse_strategy text` | 文件名解析策略：`filename`、`path`、`hybrid`、`fallback`。 |
| `parse_confidence numeric(4,3)` | 文件名解析置信度，0 到 1。 |
| `technical_status text` | 技术探测状态：`pending`、`probed`、`failed`。 |
| `technical_metadata jsonb` | ffprobe 等技术探测结果。 |
| `source_root text` | 索引时的曲库根路径。 |
| `ssh_host text` | 索引时的 NAS SSH host。 |
| `first_seen_run_id text` | 首次发现批次号，仅作文本记录。 |
| `last_seen_run_id text` | 最近发现批次号，仅作文本记录。 |
| `missing_at timestamptz` | 文件在最近索引中消失的时间；为空表示当前可用。 |
| `request_count integer` | 长期点歌次数，首页推荐权重来源。 |
| `last_requested_at timestamptz` | 最近点歌时间。 |
| `cover_image_url text` | 控制端展示的封面图片地址。可以是外部图片 URL，也可以是后续本地缓存文件的公开 URL。 |
| `cover_updated_at timestamptz` | 最近一次封面处理时间。找到封面、未找到封面或查询失败都会更新。 |
| `created_at timestamptz` | 创建时间。 |
| `updated_at timestamptz` | 更新时间。 |

关键约束和索引：

- `UNIQUE(file_path)`。
- `artist_names` 使用 GIN 索引，支持歌手分类查询。
- `style_tags` 使用 GIN 索引，支持风格分类查询。
- `request_count` 有推荐排序索引。
- `missing_at IS NULL` 的可用歌曲有 active 索引。

### `candidate_tasks`

线上候选歌曲工作流表。它保存候选发现、审核、拉取状态和 ready 结果，但不再生成独立的线上歌曲/资源表。

| 字段 | 含义 |
| --- | --- |
| `id text` | 主键。 |
| `room_id text` | 外键到 `rooms.id`。 |
| `provider text` | 候选来源。 |
| `provider_candidate_id text` | 来源侧候选 ID。 |
| `title text` | 候选歌名。 |
| `artist_name text` | 候选歌手。 |
| `source_label text` | 来源展示名。 |
| `duration_ms integer` | 时长，毫秒。 |
| `candidate_type text` | 候选类型：`mv`、`karaoke`、`audio`、`unknown`。 |
| `reliability_label text` | 可靠性：`high`、`medium`、`low`、`unknown`。 |
| `risk_label text` | 风险：`normal`、`risky`、`blocked`。 |
| `status text` | 状态：`discovered`、`selected`、`review_required`、`fetching`、`fetched`、`ready`、`failed`、`stale`、`promoted`、`purged`。 |
| `failure_reason text` | 失败原因。 |
| `recent_event jsonb` | 最近事件摘要。 |
| `provider_payload jsonb` | 来源原始数据。 |
| `ready_asset_id text` | ready 结果的资源 ID。当前是直接字段，不再外键。 |
| `ready_media_url text` | ready 结果的媒体 URL。 |
| `ready_cache_path text` | ready 结果的本地缓存路径。 |
| `ready_metadata jsonb` | ready 结果的补充元数据。 |
| `selected_at timestamptz` | 选中时间。 |
| `review_required_at timestamptz` | 需要审核时间。 |
| `fetching_at timestamptz` | 开始拉取时间。 |
| `fetched_at timestamptz` | 拉取完成时间。 |
| `ready_at timestamptz` | ready 时间。 |
| `failed_at timestamptz` | 失败时间。 |
| `stale_at timestamptz` | 过期时间。 |
| `promoted_at timestamptz` | 晋升时间。 |
| `purged_at timestamptz` | 清理时间。 |
| `created_at timestamptz` | 创建时间。 |
| `updated_at timestamptz` | 更新时间。 |

关键约束：`UNIQUE(room_id, provider, provider_candidate_id)`。

## 运维表

`schema_migrations` 由 `apps/api/scripts/apply-migrations.mjs` 维护，字段为：

- `filename text`：迁移文件名，主键。
- `applied_at timestamptz`：执行时间。

它只记录迁移执行情况，不参与业务逻辑。
