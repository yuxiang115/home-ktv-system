# KTV 风格标签表精简 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将风格标签相关业务表从 6 张精简为 1 张 `ktv_song_style_tags`，并让搜索、首页分类和独立 Python 打标脚本都使用最小关系表。

**Architecture:** PostgreSQL 继续保存歌曲和风格标签关系，但不再保存标签字典、打标运行状态或打标缓存。`ktv_song_style_tags` 直接保存 `song_id + tag_name + tag_group`，运行时查询不再 join `ktv_style_tags` 和 `ktv_style_groups`。Python 打标脚本负责生成规范标签并写入这张关系表。

**Tech Stack:** TypeScript、Fastify、Vitest、PostgreSQL SQL migration、Python unittest、现有 KTV 索引 repository。

---

### Task 1: Schema 目标测试

**Files:**
- Modify: `apps/api/src/test/ktv-style-tags-schema.test.ts`
- Read: `apps/api/src/db/schema.ts`
- Read: `apps/api/src/db/migrations/0020_ktv_style_tags_simplification.sql`

**Steps:**

1. 修改 schema 测试，断言最终 `schemaSql` 只创建 `ktv_song_style_tags` 这一张风格标签表。
2. 断言最终 `schemaSql` 不包含：
   - `CREATE TABLE IF NOT EXISTS ktv_style_groups`
   - `CREATE TABLE IF NOT EXISTS ktv_style_tags`
   - `CREATE TABLE IF NOT EXISTS ktv_song_tagging_runs`
   - `CREATE TABLE IF NOT EXISTS ktv_song_tagging_status`
   - `CREATE TABLE IF NOT EXISTS ktv_song_tagging_cache`
3. 断言最终 `schemaSql` 中 `ktv_song_style_tags` 包含 `song_id`、`tag_name`、`tag_group`、`created_at`、`updated_at`。
4. 断言最终 `schemaSql` 中有 `UNIQUE(song_id, tag_name, tag_group)`。
5. 断言迁移文件 `0020_ktv_style_tags_simplification.sql` 包含从旧三表 join 回填新表的 SQL，并删除旧表。

Run:

```bash
pnpm -F @home-ktv/api test -- src/test/ktv-style-tags-schema.test.ts
```

Expected: FAIL，因为迁移文件尚不存在，最终 schema 仍包含旧表。

### Task 2: Migration 和最终 schema

**Files:**
- Create: `apps/api/src/db/migrations/0020_ktv_style_tags_simplification.sql`
- Modify: `apps/api/src/db/schema.ts`

**Steps:**

1. 新建迁移文件 `0020_ktv_style_tags_simplification.sql`。
2. 在迁移中创建临时表或新表 `ktv_song_style_tags_new`，字段为：
   - `song_id text NOT NULL REFERENCES ktv_songs(id) ON DELETE CASCADE`
   - `tag_name text NOT NULL`
   - `tag_group text NOT NULL`
   - `created_at timestamptz NOT NULL DEFAULT now()`
   - `updated_at timestamptz NOT NULL DEFAULT now()`
3. 从旧结构回填：
   - `ktv_song_style_tags.song_id`
   - `ktv_style_tags.name` -> `tag_name`
   - `ktv_style_groups.name` -> `tag_group`
   - `min(created_at)`、`max(updated_at)` 保留历史时间。
4. 用 `GROUP BY song_id, tag_name, tag_group` 去重，避免旧表里不同 source 产生重复标签。
5. 删除旧 `ktv_song_style_tags`，把新表 rename 为 `ktv_song_style_tags`。
6. 创建唯一约束和查询索引：
   - `UNIQUE(song_id, tag_name, tag_group)`
   - `INDEX(tag_group, tag_name, song_id)`
   - `INDEX(tag_name, song_id)`
7. 删除旧表：
   - `ktv_song_tagging_cache`
   - `ktv_song_tagging_status`
   - `ktv_song_tagging_runs`
   - `ktv_style_tags`
   - `ktv_style_groups`
8. 更新 `schemaSql` 到最终结构。
9. 运行 Task 1 测试，确认通过。

Commit:

```bash
git add apps/api/src/db/schema.ts apps/api/src/db/migrations/0020_ktv_style_tags_simplification.sql apps/api/src/test/ktv-style-tags-schema.test.ts
git commit -m "refactor: simplify style tag schema"
```

### Task 3: 运行时读路径切换

**Files:**
- Modify: `apps/api/src/modules/ktv-index/ktv-index-read-repository.ts`
- Modify: `apps/api/src/test/ktv-index-read-repository.test.ts`
- Modify: `apps/api/src/routes/song-search.ts`
- Modify: `apps/api/src/routes/song-discovery.ts`
- Test: `apps/api/src/test/song-discovery-routes.test.ts`

**Steps:**

1. 修改 read repository 测试，断言搜索 SQL 不再包含：
   - `JOIN ktv_style_tags`
   - `JOIN ktv_style_groups`
   - `st.tag_id`
2. 修改测试，断言搜索 SQL 直接从 `ktv_song_style_tags` 读取 `tag_name`，并按 `tag_group, tag_name` 排序。
3. 更新 `queryIndexedRows`：
   - 聚合标签时直接 `array_agg(DISTINCT st.tag_name)`。
   - 标签搜索直接匹配 `st.tag_name` 和标准化后的 `tag_name`。
   - 删除所有 `ktv_style_tags`、`ktv_style_groups` join。
4. 保持 API 响应形状不变：
   - `styleTags` 继续返回标签名数组。
   - `category` 继续由 `styleTags` 派生。
5. 运行相关测试。

Run:

```bash
pnpm -F @home-ktv/api test -- src/test/ktv-index-read-repository.test.ts src/test/song-discovery-routes.test.ts
```

Expected: PASS。

Commit:

```bash
git add apps/api/src/modules/ktv-index/ktv-index-read-repository.ts apps/api/src/test/ktv-index-read-repository.test.ts apps/api/src/routes/song-search.ts apps/api/src/routes/song-discovery.ts apps/api/src/test/song-discovery-routes.test.ts
git commit -m "refactor: read simplified style tags"
```

### Task 4: 打标脚本和旧入口清理

**Files:**
- Modify: `scripts/tools/run_style_tagging_llm_batch.py`
- Modify: `scripts/tools/run_style_tagging_llm_batch_test.py`
- Remove or update: `apps/api/src/scripts/ktv-style-tags.ts`
- Remove or update: `apps/api/src/scripts/ktv-style-tags-export.ts`
- Remove or update: `apps/api/src/scripts/ktv-style-tags-import.ts`
- Remove or update: `apps/api/src/scripts/ktv-style-tags-jsonl.ts`
- Remove or update: `apps/api/src/modules/ktv-index/ktv-style-tagging-service.ts`
- Remove or update: `apps/api/src/modules/ktv-index/style-tagging-jsonl.ts`
- Remove or update: `scripts/tools/run-style-tagging-full.mjs`
- Remove or update: `scripts/tools/run-style-tagging-full.test.mjs`
- Remove or update: `scripts/tools/run-style-tagging-llm-batch.mjs`
- Remove or update: `scripts/tools/run-style-tagging-llm-batch.test.mjs`
- Remove or update: `scripts/tools/style-tagging-job.mjs`
- Remove or update: `scripts/tools/style-tagging-job.test.mjs`
- Modify: `deploy/docker/ktv.sh`

**Steps:**

1. 更新 Python 脚本的导入 SQL，让它只写入 `ktv_song_style_tags(song_id, tag_name, tag_group)`。
2. 删除 Python 脚本里对以下表的写入：
   - `ktv_song_tagging_runs`
   - `ktv_song_tagging_status`
   - `ktv_style_groups`
   - `ktv_style_tags`
3. 如果 Node 侧旧打标入口不再使用，则删除相关 scripts、modules 和 tests。
4. 如果某个入口还需要短期兼容，则改成失败提示，说明风格打标已迁移到独立 Python 脚本，不再由 API 服务执行。
5. 删除 `deploy/docker/ktv.sh` 中不再可用的 `tag-styles*` 命令入口。
6. 更新测试，覆盖 Python 脚本生成的新 SQL 不再引用旧表。

Run:

```bash
python3 scripts/tools/run_style_tagging_llm_batch_test.py
rg "ktv_song_tagging|ktv_style_tags|ktv_style_groups|tag-styles" apps/api/src scripts/tools deploy
```

Expected: Python 测试 PASS；引用扫描只剩下已确认保留的 Python 新表写入逻辑，或者没有旧表和旧命令引用。若某个旧入口选择短期兼容而不是删除，则保留对应测试并单独运行。

Commit:

```bash
git add apps/api/src scripts/tools deploy/docker/ktv.sh
git commit -m "chore: remove legacy style tagging runtime"
```

### Task 5: 文档更新

**Files:**
- Modify: `docs/database-schema.md`
- Modify: `docs/KTV-ARCHITECTURE.md`
- Modify: `docs/KTV-FULL-INDEX.md`
- Modify: `docs/KTV-FULL-INDEX-INTEGRATION.md`
- Modify: `docs/deployment-source.md`
- Modify: `docs/deployment-docker.md`
- Modify: `deploy/docker/README.md`

**Steps:**

1. 把数据库结构文档中的风格表从 6 张改为 1 张。
2. 删除 `ktv_style_groups`、`ktv_style_tags`、`ktv_song_tagging_runs`、`ktv_song_tagging_status`、`ktv_song_tagging_cache` 的字段说明。
3. 更新关系图，`ktv_songs -> ktv_song_style_tags` 直接连接。
4. 更新全文索引文档，说明打标由独立 Python 脚本负责。
5. 删除旧 Docker 独立 style-tagging job 的推荐描述。

### Task 6: 全量验证与最终提交

**Commands:**

```bash
pnpm -F @home-ktv/api test -- src/test/ktv-style-tags-schema.test.ts src/test/ktv-index-read-repository.test.ts src/test/song-discovery-routes.test.ts src/test/song-search-routes.test.ts
python3 scripts/tools/run_style_tagging_llm_batch_test.py
pnpm -F @home-ktv/api typecheck
pnpm -F @home-ktv/controller typecheck
pnpm -F @home-ktv/tv-web typecheck
pnpm -F @home-ktv/admin typecheck
git diff --check
```

**Optional deployment verification after code is merged locally:**

```bash
bash deploy/source/ktv.sh deploy
```

**Final commit if docs were not included in earlier commits:**

```bash
git add docs deploy
git commit -m "docs: document simplified style tag schema"
```
