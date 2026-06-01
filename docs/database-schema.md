# 数据库结构

最后更新：2026-06-01。

本文只描述当前运行中的目标结构。历史迁移过程和已删除旧表不再作为维护文档记录；需要追溯时看 Git 和数据库迁移文件。

当前业务表是 5 张：

```text
rooms
room_clients
queue_entries
ktv_songs
candidate_tasks
```

`schema_migrations` 是迁移工具表，不算业务表。

## 关系总览

```text
rooms
  -> room_clients
  -> queue_entries
  -> candidate_tasks

ktv_songs
  -> queue_entries.nas_song_id
```

当前系统支持一个房间内多台 TV 和多个控制端在线。播放状态仍是房间级状态：同一个房间只有一个当前播放目标、一条队列和一个音量。

## 表总览

| 表 | 当前职责 |
| --- | --- |
| `rooms` | 房间元信息、配对 token、房间级播放状态、音量和当前/下一首指针。 |
| `room_clients` | TV 和控制端 session。TV 用心跳表达在线状态，控制端用过期时间表达会话有效期。 |
| `queue_entries` | 当前点歌队列和短期可撤销记录。长期点歌次数不在这里统计。 |
| `ktv_songs` | NAS 曲库表。一行就是一个可播放文件，同时保存歌名、歌手、风格、路径、技术探测、封面和点歌计数。 |
| `candidate_tasks` | 线上候选歌曲工作流。当前不维护独立线上曲库表，ready 结果直接保存在任务表字段中。 |

## `rooms`

房间表同时保存配对信息和房间级播放状态。

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
| `current_queue_entry_id text` | 当前播放队列项，外键到 `queue_entries.id`。 |
| `target_vocal_mode text` | 目标声轨：`original`、`instrumental`、`dual`、`unknown`。 |
| `player_state text` | 播放状态：`idle`、`preparing`、`loading`、`playing`、`paused`、`recovering`、`error`。 |
| `player_position_ms integer` | 播放位置，非负。 |
| `next_queue_entry_id text` | 下一首队列项，外键到 `queue_entries.id`。 |
| `playback_version integer` | 播放状态版本号。 |
| `volume_percent integer` | 房间音量，0 到 100。 |
| `media_started_at timestamptz` | 当前媒体开始播放时间。 |
| `playback_updated_at timestamptz` | 播放状态更新时间。 |
| `created_at timestamptz` | 创建时间。 |
| `updated_at timestamptz` | 房间元信息或配对信息更新时间。 |

## `room_clients`

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
| `capabilities jsonb` | TV 或控制端能力。 |
| `pairing_token text` | TV 注册时使用的配对 token 快照。 |
| `created_at timestamptz` | 创建时间。 |
| `updated_at timestamptz` | 更新时间。 |

关键约束：

- `UNIQUE(room_id, client_type, device_id)`。
- 控制端必须有 `expires_at`。

## `queue_entries`

当前点歌队列表。长期点歌次数保存在 `ktv_songs.request_count`。

| 字段 | 含义 |
| --- | --- |
| `id text` | 主键。 |
| `room_id text` | 外键到 `rooms.id`。 |
| `source_type text` | 来源：`nas` 或 `online`。当前真实可播来源是 `nas`。 |
| `nas_song_id text` | NAS 歌曲 ID，外键到 `ktv_songs.id`。 |
| `nas_asset_id text` | NAS 资源 ID。当前 NAS 下必须等于 `nas_song_id`。 |
| `online_song_id text` | 线上歌曲 ID。当前没有线上曲库外键。 |
| `online_asset_id text` | 线上资源 ID。当前没有线上曲库外键。 |
| `requested_by text` | 点歌来源或控制端标识。 |
| `queue_position integer` | 队列位置。 |
| `status text` | 状态：`queued`、`preparing`、`loading`、`playing`、`played`、`skipped`、`failed`、`removed`。 |
| `priority integer` | 优先级。 |
| `playback_options jsonb` | 偏好声轨等播放选项。 |
| `requested_at timestamptz` | 点歌时间。 |
| `started_at timestamptz` | 开始播放时间。 |
| `ended_at timestamptz` | 结束时间。 |
| `removed_at timestamptz` | 删除时间。 |
| `removed_by_control_session_id text` | 删除操作的控制端客户端 ID。 |
| `undo_expires_at timestamptz` | 撤销删除截止时间。 |

关键约束：

- NAS 队列项要求 `nas_song_id` 和 `nas_asset_id` 都存在且相等。
- online 队列项要求 `online_song_id` 和 `online_asset_id` 都存在。当前 online 只是未来扩展入口。
- `queue_entries.nas_song_id -> ktv_songs.id`，`ON DELETE RESTRICT`。

## `ktv_songs`

NAS 曲库表。一条记录就是一个可播放 NAS 文件。如果同一首歌有多个版本或多个文件，它们会是多行。

| 字段 | 含义 |
| --- | --- |
| `id text` | 主键。 |
| `title text` | 歌名。 |
| `normalized_title text` | 归一化歌名，用于搜索和去重辅助。 |
| `title_pinyin text` | 歌名拼音。 |
| `title_initials text` | 歌名拼音首字母。 |
| `primary_artist_name text` | 主歌手名称。 |
| `normalized_primary_artist_name text` | 归一化主歌手名称。 |
| `artist_names text[]` | 歌手数组。多歌手直接存在数组里。 |
| `style_tags text[]` | 风格标签数组。一首歌多个标签时存在同一个数组中。 |
| `file_path text` | NAS 上的完整文件路径，唯一。 |
| `relative_path text` | 相对曲库根目录的路径。 |
| `file_name text` | 文件名。 |
| `extension text` | 文件扩展名。 |
| `size_bytes bigint` | 文件大小。 |
| `mtime_ms bigint` | 文件修改时间，毫秒时间戳。 |
| `parse_strategy text` | 文件名解析策略：`filename`、`path`、`hybrid`、`fallback`。 |
| `parse_confidence numeric(4,3)` | 文件名解析置信度，0 到 1。 |
| `technical_status text` | 技术探测状态：`pending`、`probed`、`failed`。 |
| `technical_metadata jsonb` | ffprobe 等技术探测摘要。 |
| `source_root text` | 索引时的曲库根路径。 |
| `ssh_host text` | 索引时的 SSH host。 |
| `first_seen_run_id text` | 首次发现批次号，仅作文本记录。 |
| `last_seen_run_id text` | 最近发现批次号，仅作文本记录。 |
| `missing_at timestamptz` | 文件在最近索引中消失的时间；为空表示当前可用。 |
| `request_count integer` | 长期点歌次数，首页推荐权重来源。 |
| `last_requested_at timestamptz` | 最近点歌时间。 |
| `cover_image_url text` | 控制端展示的封面图片地址。 |
| `cover_updated_at timestamptz` | 最近一次封面处理时间。 |
| `created_at timestamptz` | 创建时间。 |
| `updated_at timestamptz` | 更新时间。 |

关键索引：

- `file_path` 唯一索引。
- `normalized_title` 和 `title_pinyin` 的 trigram 索引，用于搜索。
- `artist_names` 和 `style_tags` 的 GIN 索引，用于歌手和风格分类。
- `request_count` 推荐排序索引。
- `missing_at IS NULL` 的 active 索引。

## `candidate_tasks`

线上候选歌曲工作流表。它保存候选发现、审核、拉取状态和 ready 结果，但不生成独立线上歌曲表。

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
| `ready_asset_id text` | ready 结果的资源 ID。 |
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

## 当前查询约定

- 所有面向用户的曲库查询都必须过滤 `ktv_songs.missing_at is null`。
- 歌手分类读取 `ktv_songs.artist_names`。
- 风格分类读取 `ktv_songs.style_tags`。
- 首页推荐权重读取 `ktv_songs.request_count` 和 `last_requested_at`。
- 播放链路通过 `queue_entries.nas_song_id` 指向 `ktv_songs.id`，再由媒体仓库读取文件路径。
- 封面只使用 `ktv_songs.cover_image_url`，封面 provider、置信度和错误详情只在脚本 JSONL 里保留。
