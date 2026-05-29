# 数据库结构说明

最后校验时间：2026-05-29。
校验对象：部署在 `lxc-dev:/opt/home-ktv-system` 的 PostgreSQL 数据库 `home_ktv`。

校验命令入口：

```sh
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yml \
  exec -T postgres psql -U ktv -d home_ktv
```

当前线上库有 25 张业务表。PostgreSQL 字段序号里有少量跳号，这是因为历史迁移删除过字段；本文只列出现存字段。

## 总体分组

```text
房间与控制
rooms
  -> room_pairing_tokens
  -> device_sessions
  -> control_sessions -> control_commands

NAS 曲库
ktv_index_runs
  -> ktv_song_assets -> ktv_songs
ktv_songs
  -> ktv_song_artists -> ktv_artists
  -> ktv_song_style_tags -> ktv_style_tags -> ktv_style_groups
  -> ktv_song_tagging_status -> ktv_song_tagging_runs
ktv_song_tagging_cache

线上曲库占位
online_songs -> online_song_assets
candidate_tasks -> online_song_assets

队列与播放
queue_entries
  -> rooms
  -> ktv_song_assets + ktv_songs，source_type = 'nas'
  -> online_song_assets + online_songs，source_type = 'online'
playback_sessions -> queue_entries
playback_events -> queue_entries

封面缓存
song_cover_cache，按 source_kind + source_song_id 定位歌曲

运维与迁移
schema_migrations
queue_entries_unmapped_archive
```

## 表总览

| 表 | 近似行数 | 用途 |
| --- | ---: | --- |
| `candidate_tasks` | 0 | 线上候选歌曲发现、拉取、入库工作流；当前 NAS 播放主流程不依赖它。 |
| `control_commands` | 45 | 控制端命令的幂等记录和执行结果日志。 |
| `control_sessions` | 15 | 手机控制端会话。 |
| `device_sessions` | 9 | TV 或手机设备在线状态。 |
| `ktv_artists` | 8,557 | NAS 曲库的歌手维表。 |
| `ktv_index_runs` | 2 | NAS 曲库索引任务历史。 |
| `ktv_song_artists` | 35,991 | NAS 歌曲与歌手的多对多关系。 |
| `ktv_song_assets` | 34,385 | NAS 上的实际媒体文件，以及文件解析和技术探测信息。 |
| `ktv_song_style_tags` | 61,502 | NAS 歌曲与风格标签的多对多关系。 |
| `ktv_song_tagging_cache` | 4,996 | 歌曲打标签时的提供方或 LLM 缓存。 |
| `ktv_song_tagging_runs` | 7 | 歌曲风格打标签批处理任务。 |
| `ktv_song_tagging_status` | 21,797 | 每首歌在每个打标来源上的处理状态。 |
| `ktv_songs` | 31,549 | NAS 曲库里的逻辑歌曲。 |
| `ktv_style_groups` | 5 | 风格标签分组。 |
| `ktv_style_tags` | 111 | 风格标签。 |
| `online_song_assets` | 0 | 线上歌曲可播放资源占位表。 |
| `online_songs` | 0 | 线上歌曲占位表。 |
| `playback_events` | 46 | 播放事件日志。 |
| `playback_sessions` | 1 | 每个房间当前播放状态。 |
| `queue_entries` | 18 | 房间点歌队列，支持 NAS 和线上歌曲来源。 |
| `queue_entries_unmapped_archive` | 0 | NAS/online 曲库重构迁移时无法映射队列的归档表。 |
| `room_pairing_tokens` | 1 | 房间配对 token。 |
| `rooms` | 1 | KTV 房间。 |
| `schema_migrations` | 17 | 已执行的数据库迁移文件。 |
| `song_cover_cache` | 300 | 歌曲封面查询和缓存元数据。 |

## 关系总览

### 房间、设备、控制

- `room_pairing_tokens.room_id -> rooms.id`，`ON DELETE CASCADE`。
- `device_sessions.room_id -> rooms.id`，`ON DELETE CASCADE`。
- `rooms.default_player_device_id -> device_sessions.id`，`ON DELETE SET NULL`。
- `control_sessions.room_id -> rooms.id`，`ON DELETE CASCADE`。
- `control_commands.room_id -> rooms.id`，`ON DELETE CASCADE`。
- `control_commands.control_session_id -> control_sessions.id`，`ON DELETE CASCADE`。

### NAS 曲库

- `ktv_song_assets.song_id -> ktv_songs.id`，`ON DELETE CASCADE`。
- `ktv_song_assets.first_seen_run_id -> ktv_index_runs.id`，`ON DELETE SET NULL`。
- `ktv_song_assets.last_seen_run_id -> ktv_index_runs.id`，`ON DELETE SET NULL`。
- `ktv_song_artists.song_id -> ktv_songs.id`，`ON DELETE CASCADE`。
- `ktv_song_artists.artist_id -> ktv_artists.id`，`ON DELETE CASCADE`。
- `ktv_style_tags.group_id -> ktv_style_groups.id`，`ON DELETE RESTRICT`。
- `ktv_song_style_tags.song_id -> ktv_songs.id`，`ON DELETE CASCADE`。
- `ktv_song_style_tags.tag_id -> ktv_style_tags.id`，`ON DELETE CASCADE`。
- `ktv_song_tagging_status.song_id -> ktv_songs.id`，`ON DELETE CASCADE`。
- `ktv_song_tagging_status.run_id -> ktv_song_tagging_runs.id`，`ON DELETE SET NULL`。
- `ktv_song_tagging_cache` 没有外键，它是按 `(source, cache_key)` 组织的来源缓存。

### 线上曲库

- `online_song_assets.song_id -> online_songs.id`，`ON DELETE CASCADE`。
- `candidate_tasks.room_id -> rooms.id`，`ON DELETE CASCADE`。
- `candidate_tasks.ready_online_asset_id -> online_song_assets.id`，`ON DELETE SET NULL`。

### 队列与播放

- `queue_entries.room_id -> rooms.id`，`ON DELETE CASCADE`。
- `queue_entries.removed_by_control_session_id -> control_sessions.id`，`ON DELETE SET NULL`。
- `queue_entries (nas_asset_id, nas_song_id) -> ktv_song_assets (id, song_id)`，`ON DELETE RESTRICT`。
- `queue_entries (online_asset_id, online_song_id) -> online_song_assets (id, song_id)`，`ON DELETE RESTRICT`。
- `playback_sessions.room_id -> rooms.id`，`ON DELETE CASCADE`。
- `playback_sessions.current_queue_entry_id -> queue_entries.id`，`ON DELETE SET NULL`。
- `playback_sessions.next_queue_entry_id -> queue_entries.id`，`ON DELETE SET NULL`。
- `playback_events.room_id -> rooms.id`，`ON DELETE CASCADE`。
- `playback_events.queue_entry_id -> queue_entries.id`，`ON DELETE SET NULL`。

### 封面缓存

- `song_cover_cache` 没有直接外键，因为它用的是多来源键：
  - `source_kind = 'nas'` 时，`source_song_id` 指向 `ktv_songs.id`。
  - `source_kind = 'online'` 时，`source_song_id` 指向 `online_songs.id`。
- 唯一性由 `UNIQUE (source_kind, source_song_id)` 保证。

## 关键约束

- `queue_entries.source_type` 必填。
- `queue_entries_source_identity_ck` 保证一条队列记录只属于一种来源：
  - `source_type = 'nas'` 时，必须有 `nas_song_id` 和 `nas_asset_id`，线上字段必须为空。
  - `source_type = 'online'` 时，必须有 `online_song_id` 和 `online_asset_id`，NAS 字段必须为空。
- `ktv_songs` 用 `(normalized_title, normalized_primary_artist_name)` 保证逻辑歌曲唯一。
- `ktv_song_assets.file_path` 唯一。当前有两个唯一索引同时约束这个字段：`ktv_song_assets_file_path_key` 和 `ktv_song_assets_path_uq`。
- `song_cover_cache.status` 只能是 `pending`、`found`、`not_found`、`failed`。
- `song_cover_cache.source_kind` 只能是 `nas`、`online`。

## 表字段

### `candidate_tasks`

线上候选歌曲工作流表，当前行数为 0。

| 字段 | 类型 | 可空 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `text` | 否 | `gen_random_uuid()::text` | 主键。 |
| `room_id` | `text` | 否 | - | 外键到 `rooms.id`。 |
| `provider` | `text` | 否 | - | 线上来源提供方。 |
| `provider_candidate_id` | `text` | 否 | - | 提供方候选 ID。 |
| `title` | `text` | 否 | - | 候选歌曲名。 |
| `artist_name` | `text` | 否 | - | 候选歌手名。 |
| `source_label` | `text` | 否 | - | 来源展示名。 |
| `duration_ms` | `integer` | 是 | - | 时长，必须为空或非负数。 |
| `candidate_type` | `text` | 否 | - | `mv`、`karaoke`、`audio`、`unknown`。 |
| `reliability_label` | `text` | 否 | - | `high`、`medium`、`low`、`unknown`。 |
| `risk_label` | `text` | 否 | - | `normal`、`risky`、`blocked`。 |
| `status` | `text` | 否 | `'discovered'` | 候选发现和拉取生命周期状态。 |
| `failure_reason` | `text` | 是 | - | 失败原因。 |
| `recent_event` | `jsonb` | 否 | `'{}'::jsonb` | 最近一次工作流事件。 |
| `provider_payload` | `jsonb` | 否 | `'{}'::jsonb` | 提供方原始数据。 |
| `selected_at` | `timestamptz` | 是 | - | 生命周期时间。 |
| `review_required_at` | `timestamptz` | 是 | - | 生命周期时间。 |
| `fetching_at` | `timestamptz` | 是 | - | 生命周期时间。 |
| `fetched_at` | `timestamptz` | 是 | - | 生命周期时间。 |
| `ready_at` | `timestamptz` | 是 | - | 生命周期时间。 |
| `failed_at` | `timestamptz` | 是 | - | 生命周期时间。 |
| `stale_at` | `timestamptz` | 是 | - | 生命周期时间。 |
| `promoted_at` | `timestamptz` | 是 | - | 生命周期时间。 |
| `purged_at` | `timestamptz` | 是 | - | 生命周期时间。 |
| `created_at` | `timestamptz` | 否 | `now()` | 创建时间。 |
| `updated_at` | `timestamptz` | 否 | `now()` | 更新时间。 |
| `ready_source_type` | `text` | 是 | - | 设置时只能是 `online`。 |
| `ready_online_asset_id` | `text` | 是 | - | 外键到 `online_song_assets.id`。 |

索引和约束：

- 主键：`id`。
- 唯一约束：`(room_id, provider, provider_candidate_id)`。
- 索引：`(provider, provider_candidate_id)`、`(room_id, updated_at DESC)`、`(room_id, status, updated_at DESC)`。

### `control_commands`

控制端命令的幂等日志。

| 字段 | 类型 | 可空 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `command_id` | `text` | 否 | - | 主键，也是客户端幂等键。 |
| `room_id` | `text` | 否 | - | 外键到 `rooms.id`。 |
| `control_session_id` | `text` | 否 | - | 外键到 `control_sessions.id`。 |
| `session_version` | `integer` | 否 | - | 会话版本，必须非负。 |
| `command_type` | `text` | 否 | - | 队列或播放控制命令类型。 |
| `command_payload` | `jsonb` | 否 | `'{}'::jsonb` | 命令输入参数。 |
| `result_status` | `text` | 否 | - | `accepted`、`duplicate`、`conflict`、`rejected`。 |
| `result_payload` | `jsonb` | 否 | `'{}'::jsonb` | 命令执行结果。 |
| `created_at` | `timestamptz` | 否 | `now()` | 创建时间。 |

索引和约束：

- 主键：`command_id`。
- 索引：`(room_id, created_at DESC)`。

### `control_sessions`

手机控制端会话。

| 字段 | 类型 | 可空 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `text` | 否 | `gen_random_uuid()::text` | 主键。 |
| `room_id` | `text` | 否 | - | 外键到 `rooms.id`。 |
| `device_id` | `text` | 否 | - | 控制端设备 ID。 |
| `device_name` | `text` | 否 | `'Mobile Controller'` | 设备展示名。 |
| `last_seen_at` | `timestamptz` | 否 | `now()` | 最近心跳时间。 |
| `expires_at` | `timestamptz` | 否 | - | 会话过期时间。 |
| `revoked_at` | `timestamptz` | 是 | - | 会话撤销时间。 |
| `created_at` | `timestamptz` | 否 | `now()` | 创建时间。 |
| `updated_at` | `timestamptz` | 否 | `now()` | 更新时间。 |

索引和约束：

- 主键：`id`。
- 唯一约束：`(room_id, device_id)`。
- 在线会话索引：`(room_id, expires_at, last_seen_at DESC) WHERE revoked_at IS NULL`。

### `device_sessions`

TV 或手机设备在线状态。

| 字段 | 类型 | 可空 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `text` | 否 | `gen_random_uuid()::text` | 主键。 |
| `room_id` | `text` | 否 | - | 外键到 `rooms.id`。 |
| `device_type` | `text` | 否 | - | `tv` 或 `mobile`。 |
| `device_name` | `text` | 否 | - | 设备展示名。 |
| `last_seen_at` | `timestamptz` | 是 | - | 最近心跳时间。 |
| `capabilities` | `jsonb` | 否 | `'{}'::jsonb` | 设备能力。 |
| `pairing_token` | `text` | 是 | - | 配对 token。 |
| `created_at` | `timestamptz` | 否 | `now()` | 创建时间。 |
| `updated_at` | `timestamptz` | 否 | `now()` | 更新时间。 |

索引和约束：

- 主键：`id`。

### `ktv_artists`

NAS 曲库歌手维表。

| 字段 | 类型 | 可空 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `text` | 否 | `gen_random_uuid()::text` | 主键。 |
| `name` | `text` | 否 | - | 歌手展示名。 |
| `normalized_name` | `text` | 否 | - | 搜索和去重用名称。 |
| `name_pinyin` | `text` | 否 | `''` | 拼音搜索字段。 |
| `name_initials` | `text` | 否 | `''` | 首字母搜索字段。 |
| `created_at` | `timestamptz` | 否 | `now()` | 创建时间。 |
| `updated_at` | `timestamptz` | 否 | `now()` | 更新时间。 |

索引和约束：

- 主键：`id`。
- 唯一约束：`normalized_name`。
- 搜索索引：`normalized_name` 的 GIN trigram 索引，`name_pinyin` 的 GIN trigram 索引。

### `ktv_index_runs`

NAS 曲库索引任务历史。

| 字段 | 类型 | 可空 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `text` | 否 | `gen_random_uuid()::text` | 主键。 |
| `source_root` | `text` | 否 | - | 被索引的 NAS 根目录。 |
| `ssh_host` | `text` | 是 | - | 远程索引时的 SSH 主机。 |
| `status` | `text` | 否 | `'running'` | `running`、`completed`、`failed`。 |
| `files_seen` | `integer` | 否 | `0` | 扫描到的文件数，必须非负。 |
| `songs_upserted` | `integer` | 否 | `0` | 写入或更新的歌曲数，必须非负。 |
| `assets_upserted` | `integer` | 否 | `0` | 写入或更新的资源数，必须非负。 |
| `error_message` | `text` | 是 | - | 失败原因。 |
| `started_at` | `timestamptz` | 否 | `now()` | 开始时间。 |
| `finished_at` | `timestamptz` | 是 | - | 结束时间。 |
| `created_at` | `timestamptz` | 否 | `now()` | 创建时间。 |
| `updated_at` | `timestamptz` | 否 | `now()` | 更新时间。 |

索引和约束：

- 主键：`id`。
- 索引：`(status, started_at DESC)`。

### `ktv_song_artists`

NAS 歌曲与歌手的多对多关系。

| 字段 | 类型 | 可空 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `song_id` | `text` | 否 | - | 外键到 `ktv_songs.id`。 |
| `artist_id` | `text` | 否 | - | 外键到 `ktv_artists.id`。 |
| `artist_order` | `integer` | 否 | `0` | 展示顺序，必须非负。 |
| `created_at` | `timestamptz` | 否 | `now()` | 创建时间。 |

索引和约束：

- 主键：`(song_id, artist_id)`。
- 索引：`(artist_id, song_id)`。

### `ktv_song_assets`

NAS 上的实际媒体文件，以及文件解析和技术探测信息。

| 字段 | 类型 | 可空 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `text` | 否 | `gen_random_uuid()::text` | 主键。 |
| `song_id` | `text` | 否 | - | 外键到 `ktv_songs.id`。 |
| `file_path` | `text` | 否 | - | 绝对路径或来源路径。 |
| `relative_path` | `text` | 否 | - | 相对索引根目录的路径。 |
| `file_name` | `text` | 否 | - | 文件名。 |
| `extension` | `text` | 否 | - | 文件扩展名。 |
| `size_bytes` | `bigint` | 是 | - | 文件大小，必须为空或非负。 |
| `mtime_ms` | `bigint` | 是 | - | 文件修改时间毫秒值，必须为空或非负。 |
| `parse_strategy` | `text` | 否 | - | `filename`、`path`、`hybrid`、`fallback`。 |
| `parse_confidence` | `numeric` | 否 | - | 解析置信度，范围 0 到 1。 |
| `technical_status` | `text` | 否 | `'pending'` | `pending`、`probed`、`failed`。 |
| `technical_metadata` | `jsonb` | 否 | `'{}'::jsonb` | 媒体技术探测信息，包括音视频流信息。 |
| `first_seen_run_id` | `text` | 是 | - | 首次出现的索引任务，外键到 `ktv_index_runs.id`。 |
| `last_seen_run_id` | `text` | 是 | - | 最近出现的索引任务，外键到 `ktv_index_runs.id`。 |
| `missing_at` | `timestamptz` | 是 | - | 后续索引发现文件缺失时写入。 |
| `created_at` | `timestamptz` | 否 | `now()` | 创建时间。 |
| `updated_at` | `timestamptz` | 否 | `now()` | 更新时间。 |

索引和约束：

- 主键：`id`。
- 唯一约束：`file_path`。
- 组合唯一索引：`(id, song_id)`，用于队列的组合外键校验。
- 可用资源索引：`(song_id, updated_at DESC) WHERE missing_at IS NULL`。
- 技术状态索引：`(technical_status, updated_at DESC)`。
- 注意：`ktv_song_assets_file_path_key` 和 `ktv_song_assets_path_uq` 目前都在约束 `file_path` 唯一。

### `ktv_song_style_tags`

NAS 歌曲与风格标签的多对多关系。

| 字段 | 类型 | 可空 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `song_id` | `text` | 否 | - | 外键到 `ktv_songs.id`。 |
| `tag_id` | `text` | 否 | - | 外键到 `ktv_style_tags.id`。 |
| `source` | `text` | 否 | - | 标签来源。 |
| `confidence` | `numeric` | 否 | `0` | 置信度，范围 0 到 1。 |
| `evidence` | `jsonb` | 否 | `'{}'::jsonb` | 提供方或 LLM 的证据数据。 |
| `locked` | `boolean` | 否 | `false` | 是否人工锁定。 |
| `created_at` | `timestamptz` | 否 | `now()` | 创建时间。 |
| `updated_at` | `timestamptz` | 否 | `now()` | 更新时间。 |

索引和约束：

- 主键：`(song_id, tag_id, source)`。
- 索引：`(tag_id, song_id)`、`(source, updated_at DESC)`。

### `ktv_song_tagging_cache`

歌曲风格打标的来源缓存。

| 字段 | 类型 | 可空 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `source` | `text` | 否 | - | 打标来源。 |
| `cache_key` | `text` | 否 | - | 来源内的缓存键。 |
| `payload` | `jsonb` | 否 | - | 缓存响应数据。 |
| `created_at` | `timestamptz` | 否 | `now()` | 创建时间。 |
| `updated_at` | `timestamptz` | 否 | `now()` | 更新时间。 |

索引和约束：

- 主键：`(source, cache_key)`。
- 索引：`(source, updated_at DESC)`。

### `ktv_song_tagging_runs`

歌曲风格打标批处理任务。

| 字段 | 类型 | 可空 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `text` | 否 | `gen_random_uuid()::text` | 主键。 |
| `source` | `text` | 否 | - | 打标来源。 |
| `status` | `text` | 否 | `'running'` | `running`、`completed`、`failed`。 |
| `selected_count` | `integer` | 否 | `0` | 选中的歌曲数，必须非负。 |
| `processed_count` | `integer` | 否 | `0` | 已处理歌曲数，必须非负。 |
| `tagged_count` | `integer` | 否 | `0` | 已打标歌曲数，必须非负。 |
| `empty_count` | `integer` | 否 | `0` | 空结果数量，必须非负。 |
| `failed_count` | `integer` | 否 | `0` | 失败数量，必须非负。 |
| `average_tags` | `numeric` | 是 | - | 平均标签数量。 |
| `options` | `jsonb` | 否 | `'{}'::jsonb` | 任务选项。 |
| `summary` | `jsonb` | 否 | `'{}'::jsonb` | 任务摘要。 |
| `error_message` | `text` | 是 | - | 失败原因。 |
| `started_at` | `timestamptz` | 否 | `now()` | 开始时间。 |
| `finished_at` | `timestamptz` | 是 | - | 结束时间。 |
| `created_at` | `timestamptz` | 否 | `now()` | 创建时间。 |
| `updated_at` | `timestamptz` | 否 | `now()` | 更新时间。 |

索引和约束：

- 主键：`id`。
- 索引：`(source, started_at DESC)`。

### `ktv_song_tagging_status`

每首歌在每个来源上的打标状态。

| 字段 | 类型 | 可空 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `song_id` | `text` | 否 | - | 外键到 `ktv_songs.id`。 |
| `source` | `text` | 否 | - | 打标来源。 |
| `status` | `text` | 否 | - | `pending`、`tagged`、`empty`、`failed`。 |
| `tag_count` | `integer` | 否 | `0` | 标签数量，必须非负。 |
| `confidence` | `numeric` | 是 | - | 打标置信度摘要。 |
| `run_id` | `text` | 是 | - | 外键到 `ktv_song_tagging_runs.id`。 |
| `error_message` | `text` | 是 | - | 失败原因。 |
| `updated_at` | `timestamptz` | 否 | `now()` | 更新时间。 |
| `created_at` | `timestamptz` | 否 | `now()` | 创建时间。 |

索引和约束：

- 主键：`(song_id, source)`。
- 索引：`(source, status, updated_at DESC)`。

### `ktv_songs`

NAS 曲库里的逻辑歌曲。

| 字段 | 类型 | 可空 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `text` | 否 | `gen_random_uuid()::text` | 主键。 |
| `title` | `text` | 否 | - | 歌曲展示名。 |
| `normalized_title` | `text` | 否 | - | 搜索和去重用歌名。 |
| `title_pinyin` | `text` | 否 | `''` | 拼音搜索字段。 |
| `title_initials` | `text` | 否 | `''` | 首字母搜索字段。 |
| `primary_artist_name` | `text` | 否 | - | 主歌手展示名。 |
| `normalized_primary_artist_name` | `text` | 否 | - | 搜索和去重用歌手名。 |
| `created_at` | `timestamptz` | 否 | `now()` | 创建时间。 |
| `updated_at` | `timestamptz` | 否 | `now()` | 更新时间。 |

索引和约束：

- 主键：`id`。
- 唯一约束：`(normalized_title, normalized_primary_artist_name)`。
- 搜索索引：`normalized_title` 的 GIN trigram 索引、`title_pinyin` 的 GIN trigram 索引、`title_initials` 的 btree 索引、`normalized_primary_artist_name` 的 btree 索引。

### `ktv_style_groups`

风格标签分组。

| 字段 | 类型 | 可空 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `text` | 否 | `gen_random_uuid()::text` | 主键。 |
| `name` | `text` | 否 | - | 分组名。 |
| `sort_order` | `integer` | 否 | `0` | 展示顺序。 |
| `enabled` | `boolean` | 否 | `true` | 是否启用。 |
| `created_at` | `timestamptz` | 否 | `now()` | 创建时间。 |
| `updated_at` | `timestamptz` | 否 | `now()` | 更新时间。 |

索引和约束：

- 主键：`id`。
- 唯一约束：`name`。

### `ktv_style_tags`

风格标签。

| 字段 | 类型 | 可空 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `text` | 否 | `gen_random_uuid()::text` | 主键。 |
| `group_id` | `text` | 否 | - | 外键到 `ktv_style_groups.id`。 |
| `name` | `text` | 否 | - | 标签名。 |
| `normalized_name` | `text` | 否 | - | 去重用名称。 |
| `sort_order` | `integer` | 否 | `0` | 展示顺序。 |
| `enabled` | `boolean` | 否 | `true` | 是否启用。 |
| `created_at` | `timestamptz` | 否 | `now()` | 创建时间。 |
| `updated_at` | `timestamptz` | 否 | `now()` | 更新时间。 |

索引和约束：

- 主键：`id`。
- 唯一约束：`normalized_name`。
- 索引：`(group_id, sort_order, name)`。

### `online_song_assets`

线上歌曲可播放资源占位表，当前行数为 0。

| 字段 | 类型 | 可空 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `text` | 否 | `gen_random_uuid()::text` | 主键。 |
| `song_id` | `text` | 否 | - | 外键到 `online_songs.id`。 |
| `provider` | `text` | 否 | - | 线上提供方。 |
| `provider_asset_id` | `text` | 否 | - | 提供方资源 ID。 |
| `media_url` | `text` | 否 | - | 可播放媒体 URL。 |
| `cache_path` | `text` | 是 | - | 可选的本地缓存路径。 |
| `status` | `text` | 否 | - | `ready`、`caching`、`failed`、`unavailable`。 |
| `duration_ms` | `integer` | 是 | - | 时长，必须为空或非负。 |
| `metadata` | `jsonb` | 否 | `'{}'::jsonb` | 提供方元数据。 |
| `created_at` | `timestamptz` | 否 | `now()` | 创建时间。 |
| `updated_at` | `timestamptz` | 否 | `now()` | 更新时间。 |

索引和约束：

- 主键：`id`。
- 唯一约束：`(provider, provider_asset_id)`。
- 组合唯一索引：`(id, song_id)`，用于队列的组合外键校验。

### `online_songs`

线上歌曲占位表，当前行数为 0。

| 字段 | 类型 | 可空 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `text` | 否 | `gen_random_uuid()::text` | 主键。 |
| `provider` | `text` | 否 | - | 线上提供方。 |
| `provider_song_id` | `text` | 否 | - | 提供方歌曲 ID。 |
| `title` | `text` | 否 | - | 歌曲展示名。 |
| `normalized_title` | `text` | 否 | - | 搜索用歌名。 |
| `title_pinyin` | `text` | 否 | `''` | 拼音搜索字段。 |
| `title_initials` | `text` | 否 | `''` | 首字母搜索字段。 |
| `primary_artist_name` | `text` | 否 | - | 主歌手展示名。 |
| `normalized_primary_artist_name` | `text` | 否 | - | 搜索用歌手名。 |
| `tags` | `text[]` | 否 | `'{}'::text[]` | 提供方标签。 |
| `metadata` | `jsonb` | 否 | `'{}'::jsonb` | 提供方元数据。 |
| `created_at` | `timestamptz` | 否 | `now()` | 创建时间。 |
| `updated_at` | `timestamptz` | 否 | `now()` | 更新时间。 |

索引和约束：

- 主键：`id`。
- 唯一约束：`(provider, provider_song_id)`。

### `playback_events`

播放事件日志。

| 字段 | 类型 | 可空 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `text` | 否 | `gen_random_uuid()::text` | 主键。 |
| `room_id` | `text` | 否 | - | 外键到 `rooms.id`。 |
| `queue_entry_id` | `text` | 是 | - | 可选外键到 `queue_entries.id`。 |
| `event_type` | `text` | 否 | - | 事件类型。 |
| `event_payload` | `jsonb` | 否 | `'{}'::jsonb` | 事件数据。 |
| `created_at` | `timestamptz` | 否 | `now()` | 创建时间。 |

索引和约束：

- 主键：`id`。
- 索引：`(room_id, created_at DESC)`。

### `playback_sessions`

每个房间当前播放状态。

| 字段 | 类型 | 可空 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `room_id` | `text` | 否 | - | 主键，同时外键到 `rooms.id`。 |
| `current_queue_entry_id` | `text` | 是 | - | 当前播放队列项。 |
| `target_vocal_mode` | `text` | 否 | - | `original`、`instrumental`、`dual`、`unknown`。 |
| `player_state` | `text` | 否 | - | `idle`、`preparing`、`loading`、`playing`、`paused`、`recovering`、`error`。 |
| `player_position_ms` | `integer` | 否 | `0` | 播放进度，必须非负。 |
| `next_queue_entry_id` | `text` | 是 | - | 下一首队列项。 |
| `version` | `integer` | 否 | `1` | 状态版本，必须为正数。 |
| `media_started_at` | `timestamptz` | 是 | - | 当前媒体开始播放时间。 |
| `updated_at` | `timestamptz` | 否 | `now()` | 更新时间。 |
| `volume_percent` | `integer` | 否 | `50` | 音量，范围 0 到 100。 |

索引和约束：

- 主键：`room_id`。

### `queue_entries`

房间点歌队列。现在它已经是来源感知结构，NAS 队列直接指向 `ktv_songs` 和 `ktv_song_assets`，线上队列指向 `online_songs` 和 `online_song_assets`。

| 字段 | 类型 | 可空 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `text` | 否 | `gen_random_uuid()::text` | 主键。 |
| `room_id` | `text` | 否 | - | 外键到 `rooms.id`。 |
| `requested_by` | `text` | 否 | - | 点歌来源或控制端标识。 |
| `queue_position` | `integer` | 否 | - | 队列顺序。 |
| `status` | `text` | 否 | - | `queued`、`preparing`、`loading`、`playing`、`played`、`skipped`、`failed`、`removed`。 |
| `priority` | `integer` | 否 | `0` | 优先级。 |
| `playback_options` | `jsonb` | 否 | `'{}'::jsonb` | 当前队列项播放选项。 |
| `requested_at` | `timestamptz` | 否 | `now()` | 点歌时间。 |
| `started_at` | `timestamptz` | 是 | - | 开始播放时间。 |
| `ended_at` | `timestamptz` | 是 | - | 结束时间。 |
| `removed_at` | `timestamptz` | 是 | - | 删除时间。 |
| `removed_by_control_session_id` | `text` | 是 | - | 删除该队列项的控制端会话。 |
| `undo_expires_at` | `timestamptz` | 是 | - | 撤销删除截止时间。 |
| `source_type` | `text` | 否 | - | `nas` 或 `online`。 |
| `nas_song_id` | `text` | 是 | - | NAS 队列项必填。 |
| `nas_asset_id` | `text` | 是 | - | NAS 队列项必填。 |
| `online_song_id` | `text` | 是 | - | 线上队列项必填。 |
| `online_asset_id` | `text` | 是 | - | 线上队列项必填。 |

索引和约束：

- 主键：`id`。
- 来源身份约束：NAS 身份和线上身份必须二选一。
- NAS 组合外键：`(nas_asset_id, nas_song_id) -> ktv_song_assets(id, song_id)`。
- 线上组合外键：`(online_asset_id, online_song_id) -> online_song_assets(id, song_id)`。
- 有效队列索引：`(room_id, status, queue_position) WHERE status IN ('queued', 'preparing', 'loading', 'playing')`。
- 推荐统计索引：`(source_type, nas_song_id) WHERE source_type = 'nas'`。

### `queue_entries_unmapped_archive`

NAS/online 曲库重构迁移时创建的归档表，当前行数为 0。

| 字段 | 类型 | 可空 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `text` | 是 | - | 归档的队列项 ID。 |
| `room_id` | `text` | 是 | - | 归档的房间 ID。 |
| `song_id` | `text` | 是 | - | 重构前的旧歌曲 ID。 |
| `asset_id` | `text` | 是 | - | 重构前的旧资源 ID。 |
| `requested_by` | `text` | 是 | - | 归档的点歌来源。 |
| `queue_position` | `integer` | 是 | - | 归档的队列顺序。 |
| `status` | `text` | 是 | - | 归档的状态。 |
| `priority` | `integer` | 是 | - | 归档的优先级。 |
| `playback_options` | `jsonb` | 是 | - | 归档的播放选项。 |
| `requested_at` | `timestamptz` | 是 | - | 归档时间字段。 |
| `started_at` | `timestamptz` | 是 | - | 归档时间字段。 |
| `ended_at` | `timestamptz` | 是 | - | 归档时间字段。 |
| `removed_at` | `timestamptz` | 是 | - | 归档时间字段。 |
| `removed_by_control_session_id` | `text` | 是 | - | 归档的控制端会话 ID。 |
| `undo_expires_at` | `timestamptz` | 是 | - | 归档的撤销截止时间。 |
| `source_type` | `text` | 是 | - | 归档的来源类型。 |
| `nas_song_id` | `text` | 是 | - | 归档的 NAS 歌曲 ID。 |
| `nas_asset_id` | `text` | 是 | - | 归档的 NAS 资源 ID。 |
| `online_song_id` | `text` | 是 | - | 归档的线上歌曲 ID。 |
| `online_asset_id` | `text` | 是 | - | 归档的线上资源 ID。 |
| `archived_at` | `timestamptz` | 是 | - | 归档时间。 |

索引和约束：

- 没有主键或外键。这张表由 `CREATE TABLE AS` 生成，只用于迁移保底。

### `room_pairing_tokens`

房间和设备配对 token。

| 字段 | 类型 | 可空 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `room_id` | `text` | 否 | - | 主键，同时外键到 `rooms.id`。 |
| `token_value` | `text` | 否 | - | 配对 token 原值。 |
| `token_hash` | `text` | 否 | - | 配对 token 哈希。 |
| `token_expires_at` | `timestamptz` | 否 | - | token 过期时间。 |
| `rotated_at` | `timestamptz` | 否 | `now()` | 最近轮换时间。 |
| `created_at` | `timestamptz` | 否 | `now()` | 创建时间。 |
| `updated_at` | `timestamptz` | 否 | `now()` | 更新时间。 |

索引和约束：

- 主键：`room_id`。
- 索引：`(room_id, token_expires_at)`。

### `rooms`

KTV 房间表。

| 字段 | 类型 | 可空 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `text` | 否 | `gen_random_uuid()::text` | 主键。 |
| `slug` | `text` | 否 | - | 对外稳定房间标识。 |
| `name` | `text` | 否 | - | 房间展示名。 |
| `status` | `text` | 否 | - | `active`、`inactive`、`maintenance`。 |
| `default_player_device_id` | `text` | 是 | - | 默认播放设备，外键到 `device_sessions.id`。 |
| `created_at` | `timestamptz` | 否 | `now()` | 创建时间。 |
| `updated_at` | `timestamptz` | 否 | `now()` | 更新时间。 |

索引和约束：

- 主键：`id`。
- 唯一约束：`slug`。

### `schema_migrations`

数据库迁移执行记录。

| 字段 | 类型 | 可空 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `filename` | `text` | 否 | - | 主键，迁移文件名。 |
| `applied_at` | `timestamptz` | 否 | `now()` | 执行时间。 |

线上库已执行迁移：

- `0001_media_contract.sql`
- `0002_library_ingest_admin.sql`
- `0003_room_sessions_control.sql`
- `0004_queue_commands.sql`
- `0005_catalog_search.sql`
- `0006_online_candidates.sql`
- `0007_real_mv_contracts.sql`
- `0008_ktv_full_index.sql`
- `0009_ktv_active_asset_indexes.sql`
- `0010_ktv_catalog_sync_source_identity.sql`
- `0011_room_volume_control.sql`
- `0012_default_room_volume_50.sql`
- `0013_ktv_style_tags.sql`
- `0014_ktv_tagging_cache.sql`
- `0015_ktv_tagging_status_per_source.sql`
- `0016_song_cover_cache.sql`
- `0017_nas_online_catalog_refactor.sql`

### `song_cover_cache`

歌曲封面查询和缓存元数据。

| 字段 | 类型 | 可空 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `text` | 否 | `gen_random_uuid()::text` | 主键。 |
| `source_kind` | `text` | 否 | - | `nas` 或 `online`。 |
| `source_song_id` | `text` | 否 | - | 当前来源下的歌曲 ID。 |
| `title` | `text` | 否 | - | 查询封面时使用的歌曲名。 |
| `artist_name` | `text` | 否 | - | 查询封面时使用的歌手名。 |
| `normalized_title` | `text` | 否 | `''` | 标准化查询歌名。 |
| `normalized_artist_name` | `text` | 否 | `''` | 标准化查询歌手名。 |
| `provider` | `text` | 是 | - | 封面来源提供方。 |
| `provider_song_id` | `text` | 是 | - | 提供方歌曲 ID。 |
| `provider_payload` | `jsonb` | 否 | `'{}'::jsonb` | 提供方原始数据。 |
| `image_url` | `text` | 是 | - | 当前保存的是外部封面图片 URL。 |
| `status` | `text` | 否 | `'pending'` | `pending`、`found`、`not_found`、`failed`。 |
| `confidence` | `integer` | 否 | `0` | 匹配置信度，范围 0 到 100。 |
| `error_message` | `text` | 是 | - | 失败原因。 |
| `fetched_at` | `timestamptz` | 是 | - | 最近拉取时间。 |
| `created_at` | `timestamptz` | 否 | `now()` | 创建时间。 |
| `updated_at` | `timestamptz` | 否 | `now()` | 更新时间。 |

索引和约束：

- 主键：`id`。
- 唯一约束：`(source_kind, source_song_id)`。
- 命中封面查询索引：`(source_kind, source_song_id) WHERE status = 'found' AND image_url IS NOT NULL`。
- 状态索引：`(source_kind, status, updated_at)`。

## 讨论点

- `online_songs` 和 `online_song_assets` 当前为空。它们存在的原因是让队列结构提前支持清晰的 `nas`/`online` 来源拆分。
- `queue_entries` 已经不再依赖旧的 `songs`/`assets` 桥接表。NAS 点歌队列通过 `nas_song_id` 和 `nas_asset_id` 直接指向 `ktv_songs` 与 `ktv_song_assets`。
- `queue_entries_unmapped_archive` 当前为空，只用于保留重构迁移时无法映射的历史队列记录。
- `song_cover_cache` 是封面元数据最合适的归属位置。后续如果把图片下载到本地，建议在这里扩展 `external_image_url`、`local_image_path`、`image_content_type`、`image_size_bytes`、`downloaded_at` 等字段，不要放到 `ktv_songs` 或 `ktv_song_assets` 主表。
- `ktv_song_assets.file_path` 上重复的两个唯一索引可以作为后续小迁移清理。
- `song_cover_cache` 最大的结构取舍是它使用 `(source_kind, source_song_id)` 这种多来源键，因此 PostgreSQL 不能直接给它同时加到 `ktv_songs` 和 `online_songs` 的外键。它更灵活，但约束强度弱于拆成具体来源表。
