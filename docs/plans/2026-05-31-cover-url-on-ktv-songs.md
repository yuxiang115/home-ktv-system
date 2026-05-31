# 封面字段合并实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**目标：** 删除 `song_cover_cache` 表，把控制端需要的封面图片地址直接保存到 `ktv_songs`。

**架构：** `ktv_songs` 增加 `cover_image_url` 和 `cover_updated_at`。迁移把旧 `song_cover_cache` 中 NAS 已命中的 `image_url` 复制到对应歌曲行，然后删除旧表。后端封面仓储改为直接读写 `ktv_songs`，前端返回字段 `coverImageUrl` 保持不变。

**技术栈：** PostgreSQL SQL migration、TypeScript API、Vitest、pnpm/turbo typecheck。

---

### 任务 1：Schema 和迁移

**文件：**
- 新增：`apps/api/src/db/migrations/0022_merge_song_cover_cache_into_ktv_songs.sql`
- 修改：`apps/api/src/db/schema.ts`
- 修改：`apps/api/src/test/song-cover-schema.test.ts`
- 修改：`apps/api/src/test/nas-online-catalog-schema.test.ts`

**步骤：**
1. 在 `schemaSql` 的 `ktv_songs` 中增加 `cover_image_url text` 和 `cover_updated_at timestamptz`。
2. 从最终 `schemaSql` 和 `tableNames` 中移除 `song_cover_cache`。
3. 新增迁移 `0022`：补字段、迁移 NAS 已命中封面、删除旧表。
4. 更新 schema 测试，确认最终结构不再创建 `song_cover_cache`。

### 任务 2：运行时封面仓储

**文件：**
- 修改：`apps/api/src/modules/covers/song-cover-repository.ts`
- 修改：`apps/api/src/modules/covers/types.ts`
- 修改：`apps/api/src/modules/covers/cover-backfill-service.ts`
- 修改：`apps/api/src/scripts/song-covers.ts`

**步骤：**
1. 把封面仓储命名收敛为 `SongCoverRepository`，SQL 改为读写 `ktv_songs`。
2. `findBySongKeys()` 从 `ktv_songs.cover_image_url` 返回 NAS 封面。
3. `listCoverCandidates()` 默认列出 `cover_image_url is null` 且未处理过的 NAS 歌曲；`--retry-failed` 时重新处理已处理但仍无封面的歌曲。
4. `upsertCoverResult()` 只在找到封面时更新 `cover_image_url`，所有处理结果都会更新 `cover_updated_at`。
5. 当前线上来源保持 no-op。

### 任务 3：文档和 Runbook

**文件：**
- 修改：`docs/database-schema.md`
- 修改：`docs/KTV-ARCHITECTURE.md`
- 修改：`docs/KTV-FULL-INDEX.md`
- 修改：`docs/runbooks/song-cover-fetching.md`
- 修改：`docs/runbooks/nas-online-catalog-migration.md`
- 修改：`docs/plans/2026-05-31-catalog-schema-simplification.md`

**步骤：**
1. 将业务表数量从 6 改为 5。
2. 在 `ktv_songs` 字段说明中记录 `cover_image_url` 和 `cover_updated_at`。
3. 当前架构和 runbook 中不再把 `song_cover_cache` 描述为现役表。
4. 只在迁移历史说明里保留旧表引用。

### 任务 4：验证和提交

**命令：**
- `pnpm -F @home-ktv/api test -- src/test/song-cover-schema.test.ts src/test/song-discovery-routes.test.ts src/test/nas-online-catalog-schema.test.ts`
- `pnpm -F @home-ktv/api test -- src/test/ktv-full-index.test.ts src/test/ktv-index-read-repository.test.ts src/test/song-cover-coverage-cli.test.ts`
- `pnpm typecheck`
- `git diff --check`

**步骤：**
1. 运行封面、发现页和曲库结构相关测试。
2. 运行 typecheck 和 diff check。
3. 用 `合并封面缓存到曲库表` 提交。
4. 快进合并到 `main`，重新跑关键验证后推送。
