# 多 TV 端支持 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 支持同一房间内多台 TV 端同时在线并镜像播放同一房间内容。

**Architecture:** 保持一房间一份播放状态，移除 TV 注册时的活跃设备冲突阻断。`device_sessions` 继续保存每台 TV 的在线状态，控制端快照通过新增 `tvPresence.onlineCount` 和 `tvPresence.devices` 暴露多 TV 在线情况，同时保留旧字段兼容前端。

**Tech Stack:** TypeScript、Fastify、Vitest、React、PostgreSQL 现有 schema。

---

### Task 1: 后端行为测试

**Files:**
- Create: `apps/api/src/test/multi-tv-support.test.ts`

**Step 1: Write the failing tests**

测试两个行为：

- 第二台 TV 调用 `POST /player/bootstrap` 时也返回 `registered`。
- 控制端会话返回的 snapshot 里的 `tvPresence.onlineCount` 为 2，`devices` 包含两台 TV。

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm -F @home-ktv/api test -- src/test/multi-tv-support.test.ts
```

Expected: FAIL，因为当前第二台 TV 会返回 `conflict`，且 `tvPresence` 没有多设备字段。

### Task 2: 后端实现

**Files:**
- Modify: `apps/api/src/modules/player/register-player.ts`
- Modify: `apps/api/src/modules/rooms/build-control-snapshot.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `packages/player-contracts/src/index.ts`

**Steps:**

1. 从 `registerPlayer` 移除 `detectPlayerConflict` 阻断，所有 TV 端注册成功。
2. 给 `PlayerDeviceSessionRepository` 增加 `listActiveTvPlayers(roomId, activeAfter)`。
3. PostgreSQL repository 和 in-memory repository 都实现多 TV 列表。
4. `buildRoomControlSnapshot` 使用列表生成 `tvPresence.onlineCount` 和 `tvPresence.devices`，旧字段取最近活跃 TV。
5. 重新运行 Task 1 测试，确认通过。

### Task 3: 控制端展示

**Files:**
- Modify: `apps/controller/src/App.tsx`
- Modify: `apps/controller/src/i18n.tsx`

**Steps:**

1. 控制端状态条读取 `snapshot.tvPresence.onlineCount`。
2. 在线数量大于 1 时显示“{count} 台电视在线”。
3. 英文环境显示“{count} TVs online”。

### Task 4: 文档与验证

**Files:**
- Modify: `docs/database-schema.md`

**Steps:**

1. 更新 `device_sessions` 和 `playback_sessions` 的说明：多 TV 端在线，一房间一份播放状态。
2. Run:

```bash
pnpm -F @home-ktv/api test -- src/test/multi-tv-support.test.ts
pnpm -F @home-ktv/api test -- src/test/control-session-schema.test.ts
pnpm -F @home-ktv/controller typecheck
pnpm -F @home-ktv/tv-web typecheck
pnpm -F @home-ktv/api typecheck
git diff --check
```

3. Commit:

```bash
git add docs/plans/2026-05-29-multi-tv-support-design.md docs/plans/2026-05-29-multi-tv-support.md apps/api/src/test/multi-tv-support.test.ts apps/api/src/modules/player/register-player.ts apps/api/src/modules/rooms/build-control-snapshot.ts apps/api/src/server.ts packages/player-contracts/src/index.ts apps/controller/src/App.tsx apps/controller/src/i18n.tsx docs/database-schema.md
git commit -m "feat: support multiple tv players"
```
