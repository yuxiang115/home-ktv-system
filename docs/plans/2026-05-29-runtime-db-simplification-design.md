# 运行态数据库简化设计

最后更新：2026-05-29。

## 目标

把“房间与控制”“队列与播放”相关的运行态数据表收敛到少量清晰表里，降低后续维护成本，同时保留真实曲库、封面缓存、风格标签、歌曲点歌次数等长期数据。

这次迁移允许清空当前队列、控制端 session、TV 在线状态和短期播放状态。迁移后 TV 端和控制端需要重新连接或重新配对。

## 当前问题

当前运行态链路拆得过细：

- `room_pairing_tokens` 只保存每个房间一条配对 token，但它本质上是 `rooms` 的运行态字段。
- `device_sessions` 和 `control_sessions` 都是在表达“某个房间下的客户端在线/会话状态”，只是客户端类型不同。
- `control_commands` 是控制命令幂等记录，适合大规模多控制端审计，但家庭 KTV 场景不需要长期落库。
- `playback_sessions` 是每个房间一条播放状态，和 `rooms` 一对一。
- `playback_events` 是短期事件日志，目前没有承担必须持久化的用户功能。
- `queue_entries` 同时承担当前队列和历史点歌统计，导致推荐逻辑依赖一张本该短生命周期的表。

这些表的边界不够直观，也让迁移、文档、仓储代码都更复杂。

## 推荐方案

保留 PostgreSQL，不引入 Redis。先把短期运行态压缩到 3 张表：

| 表 | 职责 |
| --- | --- |
| `rooms` | 房间元信息、配对 token 字段、房间级当前播放状态。 |
| `room_clients` | TV 端和控制端的 session / presence，靠 `client_type` 区分 `tv` 与 `controller`。 |
| `queue_entries` | 当前或短期可撤销队列，不再作为长期历史统计表。 |

同时在 `ktv_songs` 增加：

- `request_count integer not null default 0`：歌曲累计点歌次数，用于首页推荐权重。
- `last_requested_at timestamptz`：最近一次点歌时间，用于后续排序、排查和推荐策略扩展。

删除以下运行态表：

- `room_pairing_tokens`
- `device_sessions`
- `control_sessions`
- `control_commands`
- `playback_sessions`
- `playback_events`

## 新表与字段

### `rooms`

保留原字段：

- `id`
- `slug`
- `name`
- `status`
- `default_player_device_id`
- `created_at`
- `updated_at`

新增配对字段：

- `pairing_token_value`
- `pairing_token_hash`
- `pairing_token_expires_at`
- `pairing_token_rotated_at`

新增播放字段：

- `current_queue_entry_id`
- `target_vocal_mode`
- `player_state`
- `player_position_ms`
- `next_queue_entry_id`
- `playback_version`
- `volume_percent`
- `media_started_at`
- `playback_updated_at`

`rooms.default_player_device_id` 保留为兼容字段，指向最近注册或默认 TV 客户端，但不代表唯一 TV。

### `room_clients`

统一保存 TV 端和控制端：

- `id`
- `room_id`
- `client_type`：`tv` 或 `controller`
- `device_id`
- `device_name`
- `last_seen_at`
- `expires_at`
- `revoked_at`
- `capabilities`
- `pairing_token`
- `created_at`
- `updated_at`

约束：

- `UNIQUE(room_id, client_type, device_id)`
- `client_type = 'controller'` 时必须有 `expires_at`
- `client_type = 'tv'` 时允许 `expires_at` 为空，TV 在线状态继续按 `last_seen_at` 判断

## 迁移策略

迁移顺序：

1. 给 `ktv_songs` 增加 `request_count` 和 `last_requested_at`。
2. 从旧 `queue_entries` 按 NAS 歌曲聚合点歌次数，回填到 `ktv_songs`。
3. 给 `rooms` 增加配对与播放字段，初始化为空闲播放状态。
4. 创建 `room_clients`。
5. 清空 `queue_entries`，因为用户已经确认当前队列可以丢弃。
6. 删除旧运行态表。
7. 重建必要外键和索引。

不迁移控制端 session、TV 在线状态、命令记录和播放事件。它们都属于运行态，迁移后重新建立即可。

## 代码影响

- `PgRoomPairingTokenRepository` 改为读写 `rooms` 的配对字段。
- `PgControlSessionRepository` 改为读写 `room_clients` 中 `client_type = 'controller'` 的记录。
- `PgPlayerDeviceSessionRepository` 改为读写 `room_clients` 中 `client_type = 'tv'` 的记录。
- `PgPlaybackSessionRepository` 改为读写 `rooms` 的播放字段。
- `PgQueueEntryRepository.append` 对 NAS 歌曲入队时同步递增 `ktv_songs.request_count` 和 `last_requested_at`。
- `listGlobalSongRequestCounts` 改为从 `ktv_songs.request_count` 读取，不再扫描 `queue_entries`。
- `PgRoomSessionCommandRepository` 替换为进程内幂等缓存。
- `PgPlaybackEventRepository` 替换为进程内短期事件仓储，避免恢复 `playback_events` 表。

## 风险

- 迁移会清空当前队列和在线状态。部署后需要重新打开 TV 端并重新进入控制端。
- 进程内命令幂等缓存重启后会丢失。家庭局域网场景可以接受；如果后续需要跨重启幂等，再评估 Redis。
- `playback_events` 删除后不能从数据库查询历史播放事件。当前产品没有依赖该能力。

## 验收标准

- 新 schema 不再创建旧的 6 张运行态表。
- 新迁移明确删除旧运行态表并清空当前队列。
- TV 注册、控制端 session、配对 token、播放状态、队列点歌都能通过现有接口工作。
- 首页推荐权重来自 `ktv_songs.request_count`。
- 数据库文档用中文反映新结构。
