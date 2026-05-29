# 运行态数据库简化 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将房间控制与播放运行态从多张细碎表简化为 `rooms`、`room_clients`、`queue_entries`，并把长期点歌统计迁移到 `ktv_songs`。

**Architecture:** PostgreSQL 继续作为唯一持久化存储。`rooms` 保存一房间一份配对与播放状态，`room_clients` 保存 TV/控制端 presence，`queue_entries` 只保存当前队列；长期推荐权重由 `ktv_songs.request_count` 提供。迁移期间清空当前队列、控制端 session 和 TV 在线状态。

**Tech Stack:** TypeScript、Fastify、Vitest、PostgreSQL SQL migration、现有 repository 接口。

---

### Task 1: Schema 目标测试

**Files:**
- Create: `apps/api/src/test/runtime-db-simplification-schema.test.ts`
- Read: `apps/api/src/db/schema.ts`
- Read: `apps/api/src/db/migrations/0019_runtime_db_simplification.sql`

**Step 1: Write the failing test**

验证：

- `schemaSql` 和 `0019_runtime_db_simplification.sql` 包含 `room_clients`。
- `schemaSql` 不再包含 `room_pairing_tokens`、`device_sessions`、`control_sessions`、`control_commands`、`playback_sessions`、`playback_events` 的建表语句。
- `rooms` 包含配对字段和播放字段。
- `ktv_songs` 包含 `request_count` 与 `last_requested_at`。
- 迁移文件包含回填 `request_count`、清空 `queue_entries`、删除旧运行态表。

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm -F @home-ktv/api test -- src/test/runtime-db-simplification-schema.test.ts
```

Expected: FAIL，因为迁移文件尚不存在，`schemaSql` 仍创建旧运行态表。

### Task 2: Repository SQL 目标测试

**Files:**
- Modify: `apps/api/src/test/queue-entry-repository.test.ts`
- Modify: `apps/api/src/test/playback-session-repository.test.ts`
- Create: `apps/api/src/test/runtime-client-repositories.test.ts`

**Step 1: Write failing tests**

覆盖：

- `PgQueueEntryRepository.listGlobalSongRequestCounts` 从 `ktv_songs` 读取 `request_count`。
- `PgQueueEntryRepository.append` 插入 NAS 队列后更新 `ktv_songs.request_count`。
- `PgPlaybackSessionRepository` 所有读写 SQL 指向 `rooms`，不再访问 `playback_sessions`。
- `PgRoomPairingTokenRepository` 读写 `rooms` 的配对字段。
- `PgControlSessionRepository` 读写 `room_clients` 且带 `client_type = 'controller'`。
- `PgPlayerDeviceSessionRepository` 读写 `room_clients` 且带 `client_type = 'tv'`。

**Step 2: Run tests to verify they fail**

Run:

```bash
pnpm -F @home-ktv/api test -- src/test/queue-entry-repository.test.ts src/test/playback-session-repository.test.ts src/test/runtime-client-repositories.test.ts
```

Expected: FAIL，因为生产代码仍访问旧表。

### Task 3: Migration 和 schema 实现

**Files:**
- Create: `apps/api/src/db/migrations/0019_runtime_db_simplification.sql`
- Modify: `apps/api/src/db/schema.ts`

**Steps:**

1. 新增迁移文件。
2. 在 `ktv_songs` 上新增 `request_count`、`last_requested_at`。
3. 在清空队列前从旧 `queue_entries` 聚合 NAS 点歌次数并回填。
4. 删除 `rooms` 到 `device_sessions` 的旧外键。
5. 给 `rooms` 增加配对与播放字段。
6. 创建 `room_clients`。
7. 清空 `queue_entries`。
8. 删除旧运行态表。
9. 调整 `queue_entries.removed_by_control_session_id` 外键指向 `room_clients(id)`，保持字段名不做大范围重命名。
10. 更新 `schemaSql` 到最终结构。
11. 运行 Task 1 测试，确认通过。

### Task 4: Repository 实现

**Files:**
- Modify: `apps/api/src/modules/rooms/repositories/pairing-token-repository.ts`
- Modify: `apps/api/src/modules/controller/repositories/control-session-repository.ts`
- Modify: `apps/api/src/modules/player/register-player.ts`
- Modify: `apps/api/src/modules/playback/repositories/playback-session-repository.ts`
- Modify: `apps/api/src/modules/playback/repositories/queue-entry-repository.ts`
- Modify: `apps/api/src/modules/playback/repositories/room-session-command-repository.ts`
- Modify: `apps/api/src/modules/playback/repositories/playback-event-repository.ts`
- Modify: `apps/api/src/runtime/pg-runtime-repositories.ts`

**Steps:**

1. Pairing token repository 改写到 `rooms`。
2. 控制端 session repository 改写到 `room_clients`。
3. TV device session repository 改写到 `room_clients`。
4. Playback session repository 改写到 `rooms`。
5. Queue entry repository 点歌时递增 `ktv_songs.request_count`。
6. Queue entry repository 统计从 `ktv_songs` 读取。
7. 增加进程内 command repository 并让 PG runtime 使用它。
8. 增加进程内 playback event repository 并让 PG runtime 使用它。
9. 运行 Task 2 测试，确认通过。

### Task 5: 文档更新

**Files:**
- Modify: `docs/database-schema.md`

**Steps:**

1. 更新数据表总览。
2. 更新“房间与控制”章节，只保留 `rooms` 和 `room_clients`。
3. 更新“队列与播放”章节，说明 `queue_entries` 是短期队列，播放状态在 `rooms`。
4. 更新 `ktv_songs` 字段说明，加入 `request_count` 和 `last_requested_at`。
5. 删除旧运行态表字段章节。

### Task 6: 全量验证与提交

**Commands:**

```bash
pnpm -F @home-ktv/api test -- src/test/runtime-db-simplification-schema.test.ts src/test/runtime-client-repositories.test.ts src/test/queue-entry-repository.test.ts src/test/playback-session-repository.test.ts src/test/control-session-schema.test.ts src/test/song-discovery-routes.test.ts
pnpm -F @home-ktv/api typecheck
pnpm -F @home-ktv/controller typecheck
pnpm -F @home-ktv/tv-web typecheck
pnpm -F @home-ktv/admin typecheck
pnpm -F @home-ktv/player-contracts build
git diff --check
```

**Commit:**

```bash
git add docs/plans/2026-05-29-runtime-db-simplification-design.md docs/plans/2026-05-29-runtime-db-simplification.md apps/api/src docs/database-schema.md
git commit -m "refactor: simplify runtime database state"
```
