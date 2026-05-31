# 曲库表结构最小化实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 NAS 曲库压缩为单表 `ktv_songs`，删除线上曲库占位表，只保留当前真实运行需要的数据结构。

**Architecture:** `ktv_songs` 从“逻辑歌曲表”改为“NAS 可播放文件表”：一行就是一个可点播文件，同时保存歌曲标题、歌手数组、风格数组、文件路径、技术探测、索引批次和点歌统计。`candidate_tasks` 继续承载线上候选工作流，但 ready 结果直接存在本表，不再外键到线上资源表。`queue_entries` 保留现有 `nas_*` / `online_*` 来源字段以降低播放链路风险，NAS 侧约束改为 `nas_song_id -> ktv_songs.id` 且 `nas_song_id = nas_asset_id`。

**Tech Stack:** PostgreSQL SQL migration, TypeScript API, Vitest, Python tagging helper tests.

---

> 更新：后续 `0022_merge_song_cover_cache_into_ktv_songs.sql` 又把 `song_cover_cache` 合并进 `ktv_songs.cover_image_url`，因此当前最终业务表不再包含 `song_cover_cache`。

## 目标结构

保留业务表：

- `rooms`
- `room_clients`
- `queue_entries`
- `ktv_songs`
- `candidate_tasks`

删除业务表：

- `ktv_song_assets`
- `ktv_artists`
- `ktv_song_artists`
- `ktv_index_runs`
- `ktv_song_style_tags`
- `online_songs`
- `online_song_assets`

## 迁移策略

1. 新建 `0021_catalog_schema_simplification.sql`。
2. 从旧 `ktv_song_assets + ktv_songs` 生成新 `ktv_songs_minimal`：
   - 新 `id = 旧 ktv_song_assets.id`。
   - 标题、主歌手、点歌计数来自旧 `ktv_songs`。
   - 文件路径、技术探测、missing 状态来自旧 `ktv_song_assets`。
   - `artist_names text[]` 来自旧歌手关系表；没有时回退为主歌手。
   - `style_tags text[]` 来自旧风格标签表；没有时为空数组。
   - `first_seen_run_id`、`last_seen_run_id` 保留为文本，不再外键到运行历史表。
3. 复制 NAS 封面缓存：旧 cache 以逻辑 song id 为 key，迁移后按每个可播放文件 id 复制一份。
4. 更新队列：NAS 队列的 `nas_song_id` 改成 `nas_asset_id`，使 song id 和 asset id 指向同一行。
5. `candidate_tasks` 把 `ready_online_asset_id` 迁移为直接字段 `ready_asset_id`，删除线上资源外键。
6. 删除旧表，重命名 `ktv_songs_minimal -> ktv_songs`，重建索引和轻量 FK。

## 代码改造

1. `apps/api/src/db/schema.ts`
   - 删除线上占位表和 NAS 维表定义。
   - 扩展 `ktv_songs` 文件、歌手数组、风格数组和技术探测字段。
   - 更新 `candidate_tasks` ready 字段。
   - 更新 `queue_entries` NAS 外键。
2. `apps/api/src/modules/ingest/ktv-full-index.ts`
   - 索引器直接 upsert `ktv_songs`，以 `file_path` 去重。
   - 用本次 run id 标记 `last_seen_run_id`，缺失文件直接更新 `ktv_songs.missing_at`。
3. `apps/api/src/modules/ktv-index/ktv-index-read-repository.ts`
   - 搜索、歌手分类、风格分类、诊断全部从 `ktv_songs` 查询。
   - 歌手分类用 `artist_names` 展开，`artistId = artistName`。
   - 风格分类用 `style_tags` 展开。
4. `apps/api/src/modules/media/nas-playable-media-repository.ts` 和 `apps/api/src/routes/media.ts`
   - NAS 媒体读取直接查 `ktv_songs`。
5. `apps/api/src/modules/ktv-index/ktv-index-technical-probe.ts`
   - 技术探测目标和回写改为 `ktv_songs`。
6. `apps/api/src/modules/online/repositories/candidate-task-repository.ts`
   - ready 字段改为 `ready_asset_id`。
7. 封面脚本和打标脚本
   - 封面 NAS 候选查 `ktv_songs`。
   - 线上覆盖率样本改从 `candidate_tasks` 的 ready 任务取。
   - 风格打标脚本改为读写 `ktv_songs.style_tags`。
8. 文档
   - 更新 `docs/database-schema.md`。

## 测试与验证

1. 先更新 schema/仓储/脚本测试，让它们断言最终 schema 不再包含被删除表。
2. 运行相关测试确认先失败。
3. 完成实现后运行：
   - `pnpm -F @home-ktv/api test -- src/test/ktv-full-index.test.ts src/test/ktv-index-read-repository.test.ts src/test/ktv-index-technical-probe.test.ts src/test/nas-playable-media-repository.test.ts src/test/nas-online-catalog-schema.test.ts src/test/ktv-style-tags-schema.test.ts src/test/song-cover-schema.test.ts src/test/online-candidate-task.test.ts`
   - `python3 scripts/tools/run_style_tagging_llm_batch_test.py`
   - `pnpm -F @home-ktv/api typecheck`
   - `git diff --check`

## 回滚原则

这次迁移会删除旧表。部署前应先备份数据库；如果迁移后发现问题，直接恢复数据库备份并回滚代码版本。当前项目是家庭自用，不保留旧范式表作为运行时兼容层。
