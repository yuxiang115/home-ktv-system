# 曲库标签 LLM 兜底实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为真实曲库风格标签增加只处理空结果和低覆盖歌曲的 LLM 兜底来源。

**Architecture:** 网易云继续作为主标签来源。LLM 作为独立来源写入 `ktv_song_style_tags`，状态表改为 `(song_id, source)` 复合主键，避免来源互相覆盖。CLI 通过 `--source llm` 启用 OpenAI-compatible Chat Completions 客户端。

**Tech Stack:** TypeScript, Node.js fetch, PostgreSQL migrations, Vitest, pnpm workspace, Docker Compose deploy wrapper.

---

### Task 1: 状态表支持多来源

**Files:**
- Create: `apps/api/src/db/migrations/0015_ktv_tagging_status_per_source.sql`
- Modify: `apps/api/src/db/schema.ts`
- Modify: `apps/api/src/modules/ktv-index/ktv-style-tagging-service.ts`
- Modify: `apps/api/src/test/ktv-style-tags-schema.test.ts`
- Modify: `apps/api/src/test/ktv-style-tagging-service.test.ts`

**Steps:**
1. 写失败测试，断言最终 schema 里 `ktv_song_tagging_status` 使用 `PRIMARY KEY (song_id, source)`。
2. 写失败测试，断言同一首歌可为 `netease-playlist-v1` 和 `llm-style-v1` 各写一条状态。
3. 运行相关测试，确认失败。
4. 新增迁移，更新 schema 和 `ON CONFLICT (song_id, source)`。
5. 重新运行测试，确认通过。

### Task 2: LLM 标签客户端

**Files:**
- Create: `apps/api/src/modules/ktv-index/llm-style-tagger.ts`
- Create: `apps/api/src/test/llm-style-tagger.test.ts`

**Steps:**
1. 写失败测试，覆盖 JSON 输出解析、markdown code fence 解析、非法标签过滤、最多 6 个标签。
2. 运行测试，确认失败。
3. 实现 OpenAI-compatible `/chat/completions` 客户端和 `LlmStyleTagger`。
4. 重新运行测试，确认通过。

### Task 3: 低覆盖选择逻辑

**Files:**
- Modify: `apps/api/src/modules/ktv-index/ktv-style-tagging-service.ts`
- Modify: `apps/api/src/test/ktv-style-tagging-service.test.ts`

**Steps:**
1. 写失败测试，断言 `maxExistingTags=1` 时只选择 0 或 1 个聚合标签的歌曲，并跳过已完成当前来源的歌曲。
2. 运行测试，确认失败。
3. 扩展选择 SQL 和 run options。
4. 重新运行测试，确认通过。

### Task 4: CLI 和部署入口

**Files:**
- Modify: `apps/api/src/scripts/ktv-style-tags.ts`
- Modify: `apps/api/src/test/ktv-style-tags-cli.test.ts`
- Modify: `deploy/docker/README.md`

**Steps:**
1. 写失败测试，覆盖 `--source llm`、LLM URL/key/model、`--max-existing-tags`。
2. 运行测试，确认失败。
3. 实现 CLI 分支，Docker wrapper 继续复用 `tag-styles`。
4. 重新运行 CLI 测试和 API build typecheck。

### Task 5: 服务器验证

**Steps:**
1. 推送代码并在 `lxc-dev` 拉取。
2. 执行迁移和 `doctor`。
3. 用 LLM 对低覆盖歌曲跑小样本 apply。
4. 查询 `llm-style-v1` 覆盖率和失败样本。
