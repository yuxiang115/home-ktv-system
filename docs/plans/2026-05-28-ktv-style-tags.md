# 真实曲库多标签实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 删除 `ktv_songs.category` 的产品依赖，建立真实曲库多标签表，并实现网易云 API 样本打标签命令。

**Architecture:** 标签作为 `ktv_songs` 之外的多对多数据维护。索引搜索先兼容无标签状态，分类展示后续基于 `styleTags` 扩展。网易云打标签通过独立 CLI 执行，默认只处理缺失标签的歌曲，并输出统计报告。

**Tech Stack:** TypeScript, Node.js, PostgreSQL SQL migrations, Fastify domain types, Vitest, NeteaseCloudMusicApi over HTTP, pnpm workspace.

---

### Task 1: 迁移 schema 测试

**Files:**
- Modify: `apps/api/src/test/ktv-full-index.test.ts`
- Create: `apps/api/src/test/ktv-style-tags-schema.test.ts`
- Create: `apps/api/src/db/migrations/0013_ktv_style_tags.sql`
- Modify: `apps/api/src/db/schema.ts`

**Steps:**
1. 写失败测试，断言最终 `schemaSql` 中 `ktv_songs` 不包含 `category text` 和 `ktv_songs_category_idx`。
2. 写失败测试，断言迁移创建 `ktv_style_groups`、`ktv_style_tags`、`ktv_song_style_tags`、`ktv_song_tagging_runs`、`ktv_song_tagging_status`。
3. 运行 `pnpm -F @home-ktv/api exec vitest run src/test/ktv-full-index.test.ts src/test/ktv-style-tags-schema.test.ts`，确认失败。
4. 实现迁移和 `schemaSql`。
5. 重新运行测试，确认通过。

### Task 2: 去除后端 category 依赖

**Files:**
- Modify: `apps/api/src/modules/ingest/ktv-full-index.ts`
- Modify: `apps/api/src/modules/ktv-index/ktv-index-read-repository.ts`
- Modify: `apps/api/src/modules/catalog/ktv-catalog-sync-service.ts`
- Modify: `packages/domain/src/index.ts`
- Update related tests under `apps/api/src/test/`

**Steps:**
1. 先更新测试期望：索引 importer 按歌名和主歌手 upsert；搜索不再按 `s.category` 匹配；API 响应新增 `styleTags`，旧 `category` 只作为兼容展示字段由标签派生。
2. 运行相关测试，确认失败。
3. 修改 SQL 和类型，所有 `s.category` 查询改为标签聚合或空标签兼容。
4. 重新运行相关测试。

### Task 3: 网易云打标签核心服务

**Files:**
- Create: `apps/api/src/modules/ktv-index/style-taxonomy.ts`
- Create: `apps/api/src/modules/ktv-index/netease-style-tagger.ts`
- Create: `apps/api/src/modules/ktv-index/ktv-style-tagging-service.ts`
- Create: `apps/api/src/test/ktv-style-tagging-service.test.ts`

**Steps:**
1. 写测试覆盖：选择待处理歌曲、调用 mock 网易云客户端、只写白名单标签、空标签记录为 `empty`、失败记录为 `failed`。
2. 运行测试，确认失败。
3. 实现标签白名单、关键词规则、网易云客户端和写库服务。
4. 运行测试，确认通过。

### Task 4: CLI 与脚本入口

**Files:**
- Create: `apps/api/src/scripts/ktv-style-tags.ts`
- Create: `apps/api/src/test/ktv-style-tags-cli.test.ts`
- Modify: `apps/api/package.json`
- Modify: `package.json`

**Steps:**
1. 写 CLI 参数测试：`--limit`、`--apply`、`--dry-run`、`--only-missing`、`--source netease`、`--base-url`。
2. 运行测试，确认失败。
3. 实现 CLI，输出 processed/tagged/empty/failed/averageTags/elapsedMs。
4. 运行 CLI 测试和服务测试。

### Task 5: 样本试跑

**Steps:**
1. 启动 `NeteaseCloudMusicApi`。
2. 对当前数据库跑 300 首样本，先 `--dry-run`，再按需要 `--apply`。
3. 查询标签覆盖率和分布。
4. 根据样本结果决定是否进入大模型补缺设计。
