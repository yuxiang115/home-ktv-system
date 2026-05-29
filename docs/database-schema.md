# 数据库结构说明

最后更新：2026-05-29。

本文面向项目维护和结构讨论，描述 `apps/api/src/db/schema.ts` 与迁移 `0020_ktv_style_tags_simplification.sql` 之后的目标结构。当前业务表为 13 张；`schema_migrations` 是迁移工具表，不算业务表。

## 总体分组

```text
房间、控制与播放运行态
rooms
  -> room_clients
  -> queue_entries

NAS 曲库
ktv_index_runs
  -> ktv_song_assets -> ktv_songs
ktv_songs
  -> ktv_song_artists -> ktv_artists
  -> ktv_song_style_tags

线上曲库占位
online_songs -> online_song_assets
candidate_tasks -> online_song_assets

封面缓存
song_cover_cache
```

## 表总览

| 表 | 用途 |
| --- | --- |
| `rooms` | 房间元信息、配对 token、房间级播放状态。 |
| `room_clients` | TV 端和控制端 session / 在线状态。 |
| `queue_entries` | 当前点歌队列和短期可撤销记录。 |
| `ktv_songs` | NAS 逻辑歌曲，包含长期点歌计数。 |
| `ktv_song_assets` | NAS 上的实际媒体文件和技术探测信息。 |
| `ktv_artists` | NAS 歌手维表。 |
| `ktv_song_artists` | NAS 歌曲和歌手的多对多关系。 |
| `ktv_song_style_tags` | 歌曲和风格标签的多对多关系，按 `song_id + tag_name + tag_group` 去重。 |
| `ktv_index_runs` | NAS 曲库索引任务历史。 |
| `song_cover_cache` | 歌曲封面查询和缓存元数据。 |
| `online_songs` | 线上歌曲占位表。 |
| `online_song_assets` | 线上歌曲可播放资源占位表。 |
| `candidate_tasks` | 线上候选歌曲发现、拉取、入库工作流。 |

## 关系总览

### 房间与运行态

- `room_clients.room_id -> rooms.id`，`ON DELETE CASCADE`。
- `rooms.default_player_device_id -> room_clients.id`，`ON DELETE SET NULL`。
- `rooms.current_queue_entry_id -> queue_entries.id`，`ON DELETE SET NULL`。
- `rooms.next_queue_entry_id -> queue_entries.id`，`ON DELETE SET NULL`。
- `queue_entries.room_id -> rooms.id`，`ON DELETE CASCADE`。
- `queue_entries.removed_by_control_session_id -> room_clients.id`，`ON DELETE SET NULL`。

### NAS 曲库

- `ktv_song_assets.song_id -> ktv_songs.id`，`ON DELETE CASCADE`。
- `ktv_song_assets.first_seen_run_id -> ktv_index_runs.id`，`ON DELETE SET NULL`。
- `ktv_song_assets.last_seen_run_id -> ktv_index_runs.id`，`ON DELETE SET NULL`。
- `ktv_song_artists.song_id -> ktv_songs.id`，`ON DELETE CASCADE`。
- `ktv_song_artists.artist_id -> ktv_artists.id`，`ON DELETE CASCADE`。
- `ktv_song_style_tags.song_id -> ktv_songs.id`，`ON DELETE CASCADE`。

### 队列来源

- NAS 队列：`queue_entries (nas_asset_id, nas_song_id) -> ktv_song_assets (id, song_id)`，`ON DELETE RESTRICT`。
- 线上队列：`queue_entries (online_asset_id, online_song_id) -> online_song_assets (id, song_id)`，`ON DELETE RESTRICT`。
- `queue_entries_source_identity_ck` 保证一条队列记录只属于 NAS 或线上其中一种来源。

### 线上与封面

- `online_song_assets.song_id -> online_songs.id`，`ON DELETE CASCADE`。
- `candidate_tasks.room_id -> rooms.id`，`ON DELETE CASCADE`。
- `candidate_tasks.ready_online_asset_id -> online_song_assets.id`，`ON DELETE SET NULL`。
- `song_cover_cache` 没有外键，靠 `(source_kind, source_song_id)` 定位 NAS 或线上歌曲。

## 运行态简化说明

旧的运行态表已经合并或删除：

- 配对 token 合并到 `rooms.pairing_token_*`。
- 播放状态合并到 `rooms.current_queue_entry_id`、`rooms.player_state`、`rooms.playback_version` 等字段。
- TV 在线状态和控制端 session 合并到 `room_clients`，用 `client_type = 'tv' | 'controller'` 区分。
- 控制命令幂等记录改为进程内短期缓存，不再落库。
- 播放事件改为进程内短期缓存，不再落库。
- 长期点歌统计改为 `ktv_songs.request_count`，不再扫描历史队列表。

迁移 `0019_runtime_db_simplification.sql` 会清空当前 `queue_entries`，并清空 TV 在线状态和控制端 session。真实曲库、封面缓存、风格标签和 `ktv_songs.request_count` 会保留。
迁移 `0020_ktv_style_tags_simplification.sql` 会把旧风格字典和运行态表收敛到单一 `ktv_song_style_tags` 关系表。

## 字段清单

### `rooms`

房间表，同时保存配对和房间级播放状态。

字段：

- `id text`：主键。
- `slug text`：房间短标识，唯一。
- `name text`：房间名称。
- `status text`：`active`、`inactive`、`maintenance`。
- `default_player_device_id text`：默认或最近注册的 TV 客户端，外键到 `room_clients.id`。
- `pairing_token_value text`：展示给控制端扫码或输入的配对 token。
- `pairing_token_hash text`：配对 token 校验 hash。
- `pairing_token_expires_at timestamptz`：配对 token 过期时间。
- `pairing_token_rotated_at timestamptz`：配对 token 最近轮换时间。
- `current_queue_entry_id text`：当前播放队列项。
- `target_vocal_mode text`：目标声轨，`original`、`instrumental`、`dual`、`unknown`。
- `player_state text`：播放器状态，`idle`、`preparing`、`loading`、`playing`、`paused`、`recovering`、`error`。
- `player_position_ms integer`：播放位置，非负。
- `next_queue_entry_id text`：下一首队列项。
- `playback_version integer`：播放状态版本号。
- `volume_percent integer`：房间音量，0 到 100。
- `media_started_at timestamptz`：当前媒体开始播放时间。
- `playback_updated_at timestamptz`：播放状态更新时间。
- `created_at timestamptz`：创建时间。
- `updated_at timestamptz`：房间元信息或配对信息更新时间。

### `room_clients`

统一保存 TV 端和控制端。

字段：

- `id text`：主键；TV 端通常使用设备 ID，控制端默认生成 UUID。
- `room_id text`：外键到 `rooms.id`。
- `client_type text`：`tv` 或 `controller`。
- `device_id text`：客户端设备 ID。
- `device_name text`：客户端展示名。
- `last_seen_at timestamptz`：最近心跳或会话刷新时间。
- `expires_at timestamptz`：控制端 session 过期时间；控制端必填。
- `revoked_at timestamptz`：撤销时间。
- `capabilities jsonb`：TV 能力或客户端能力。
- `pairing_token text`：TV 注册时使用的配对 token 快照。
- `created_at timestamptz`：创建时间。
- `updated_at timestamptz`：更新时间。

关键约束：`UNIQUE(room_id, client_type, device_id)`。

### `queue_entries`

当前点歌队列表。它不再承担长期点歌历史；长期统计在 `ktv_songs.request_count`。

字段：

- `id text`：主键。
- `room_id text`：外键到 `rooms.id`。
- `source_type text`：`nas` 或 `online`。
- `nas_song_id text`：NAS 歌曲 ID。
- `nas_asset_id text`：NAS 媒体文件 ID。
- `online_song_id text`：线上歌曲 ID。
- `online_asset_id text`：线上媒体资源 ID。
- `requested_by text`：点歌来源或控制端标识。
- `queue_position integer`：队列位置。
- `status text`：`queued`、`preparing`、`loading`、`playing`、`played`、`skipped`、`failed`、`removed`。
- `priority integer`：优先级。
- `playback_options jsonb`：偏好声轨、音调等播放选项。
- `requested_at timestamptz`：点歌时间。
- `started_at timestamptz`：开始播放时间。
- `ended_at timestamptz`：结束时间。
- `removed_at timestamptz`：删除时间。
- `removed_by_control_session_id text`：删除操作的控制端客户端 ID。
- `undo_expires_at timestamptz`：撤销删除截止时间。

### `ktv_songs`

NAS 逻辑歌曲表。

字段：`id`、`title`、`normalized_title`、`title_pinyin`、`title_initials`、`primary_artist_name`、`normalized_primary_artist_name`、`request_count`、`last_requested_at`、`created_at`、`updated_at`。

关键约束：`UNIQUE(normalized_title, normalized_primary_artist_name)`。

`request_count` 是首页推荐的长期权重来源；NAS 歌曲每次成功加入队列时递增。

### `ktv_song_assets`

NAS 实际媒体文件表。

字段：`id`、`song_id`、`file_path`、`relative_path`、`file_name`、`extension`、`size_bytes`、`mtime_ms`、`parse_strategy`、`parse_confidence`、`technical_status`、`technical_metadata`、`first_seen_run_id`、`last_seen_run_id`、`missing_at`、`created_at`、`updated_at`。

关键约束：`UNIQUE(file_path)`、`UNIQUE(id, song_id)`。

### `ktv_artists`

NAS 歌手表。

字段：`id`、`name`、`normalized_name`、`name_pinyin`、`name_initials`、`created_at`、`updated_at`。

关键约束：`UNIQUE(normalized_name)`。

### `ktv_song_artists`

歌曲和歌手关系表。

字段：`song_id`、`artist_id`、`artist_order`、`created_at`。

主键：`(song_id, artist_id)`。

### `ktv_index_runs`

NAS 索引任务历史。

字段：`id`、`source_root`、`ssh_host`、`status`、`files_seen`、`songs_upserted`、`assets_upserted`、`error_message`、`started_at`、`finished_at`、`created_at`、`updated_at`。

### `ktv_song_style_tags`

歌曲和风格标签关系表。

字段：`song_id`、`tag_name`、`tag_group`、`created_at`、`updated_at`。

关键约束：`UNIQUE(song_id, tag_name, tag_group)`；一首歌如果有多个标签，就用多行记录。

### `song_cover_cache`

歌曲封面缓存表。

字段：`id`、`source_kind`、`source_song_id`、`title`、`artist_name`、`normalized_title`、`normalized_artist_name`、`provider`、`provider_song_id`、`provider_payload`、`image_url`、`status`、`confidence`、`error_message`、`fetched_at`、`created_at`、`updated_at`。

关键约束：`UNIQUE(source_kind, source_song_id)`。

### `online_songs`

线上歌曲占位表。

字段：`id`、`provider`、`provider_song_id`、`title`、`normalized_title`、`title_pinyin`、`title_initials`、`primary_artist_name`、`normalized_primary_artist_name`、`tags`、`metadata`、`created_at`、`updated_at`。

关键约束：`UNIQUE(provider, provider_song_id)`。

### `online_song_assets`

线上歌曲可播放资源占位表。

字段：`id`、`song_id`、`provider`、`provider_asset_id`、`media_url`、`cache_path`、`status`、`duration_ms`、`metadata`、`created_at`、`updated_at`。

关键约束：`UNIQUE(provider, provider_asset_id)`、`UNIQUE(id, song_id)`。

### `candidate_tasks`

线上候选歌曲工作流表。

字段：`id`、`room_id`、`provider`、`provider_candidate_id`、`title`、`artist_name`、`source_label`、`duration_ms`、`candidate_type`、`reliability_label`、`risk_label`、`status`、`failure_reason`、`recent_event`、`provider_payload`、`ready_source_type`、`ready_online_asset_id`、`selected_at`、`review_required_at`、`fetching_at`、`fetched_at`、`ready_at`、`failed_at`、`stale_at`、`promoted_at`、`purged_at`、`created_at`、`updated_at`。

关键约束：`UNIQUE(room_id, provider, provider_candidate_id)`。

## 运维表

`schema_migrations` 由 `apps/api/scripts/apply-migrations.mjs` 维护，字段为 `filename` 和 `applied_at`。它只记录迁移执行情况，不参与业务逻辑。
