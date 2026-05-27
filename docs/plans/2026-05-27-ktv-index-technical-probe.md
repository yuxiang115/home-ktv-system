# 真实曲库音轨元数据探测实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为真实 `ktv_*` 索引资源回填必要音轨技术元数据，使控制端单音轨标签、Admin 诊断和部署 doctor 的音轨统计可用。

**Architecture:** 新增独立探测服务和 CLI，不改变点歌主链路。探测成功或失败都只更新 `ktv_song_assets.technical_status` 与 `technical_metadata`，失败不影响搜索和点歌。Docker 部署脚本提供 `probe-index` 命令，先支持 300 首样本，再支持全量高并发续跑。

**Tech Stack:** TypeScript, Node.js, PostgreSQL, ffprobe, existing `probeMediaFile()`, Docker Compose, pnpm workspace, node:test/vitest.

---

### Task 1: 探测服务领域测试

**Files:**
- Create: `apps/api/src/test/ktv-index-technical-probe.test.ts`
- Create: `apps/api/src/modules/ktv-index/ktv-index-technical-probe.ts`

**Step 1: 写失败测试**

覆盖以下行为：

- 只选择 `missing_at is null` 且未探测过的资源。
- `--limit` 限制待探测数量。
- 成功探测后写入 `technical_status = 'probed'` 和 `technical_metadata.mediaInfoSummary`。
- 失败后写入 `technical_status = 'failed'` 和 `technical_metadata.probeError`。
- `dryRun` 不写数据库。
- `retryFailed` 会重新选择 failed 资源。

**Step 2: 运行失败测试**

```bash
pnpm -F @home-ktv/api exec vitest run src/test/ktv-index-technical-probe.test.ts
```

Expected: FAIL，因为模块尚未实现。

**Step 3: 实现最小服务**

在 `ktv-index-technical-probe.ts` 中实现：

- `KtvIndexTechnicalProbeService`
- `probeKtvIndexAssets(input)`
- `selectProbeTargets()`
- `markProbeSucceeded()`
- `markProbeFailed()`
- `KtvIndexTechnicalProbeResult`

服务依赖注入：

- `db: QueryExecutor`
- `probeMedia?: typeof probeMediaFile`
- `pathMappings?: MediaPathMapping[]`
- `accessFile?: (filePath: string) => Promise<void>`

**Step 4: 运行通过测试**

```bash
pnpm -F @home-ktv/api exec vitest run src/test/ktv-index-technical-probe.test.ts
```

Expected: PASS。

**Step 5: 提交**

```bash
git add apps/api/src/test/ktv-index-technical-probe.test.ts apps/api/src/modules/ktv-index/ktv-index-technical-probe.ts
git commit -m "新增索引音轨探测"
```

---

### Task 2: CLI 与参数解析

**Files:**
- Create: `apps/api/src/scripts/ktv-index-probe.ts`
- Modify: `apps/api/package.json`
- Modify: `package.json`
- Test: `apps/api/src/test/ktv-index-probe-cli.test.ts`

**Step 1: 写失败测试**

覆盖 CLI 参数：

- `--limit 300`
- `--concurrency 2`
- `--retry-failed`
- `--dry-run`
- `--asset-id <id>`
- `--database-url <url>` 或 `DATABASE_URL`

**Step 2: 运行失败测试**

```bash
pnpm -F @home-ktv/api exec vitest run src/test/ktv-index-probe-cli.test.ts
```

Expected: FAIL。

**Step 3: 实现 CLI**

CLI 输出至少包含：

- selected
- probed
- failed
- skipped
- singleTrack
- dualTrack
- multiTrack
- elapsedMs

并发实现保持简单：固定 worker 数从共享队列取任务，不引入外部依赖。

**Step 4: 运行测试**

```bash
pnpm -F @home-ktv/api exec vitest run src/test/ktv-index-probe-cli.test.ts src/test/ktv-index-technical-probe.test.ts
```

Expected: PASS。

**Step 5: 提交**

```bash
git add apps/api/src/scripts/ktv-index-probe.ts apps/api/src/test/ktv-index-probe-cli.test.ts apps/api/package.json package.json
git commit -m "增加音轨探测命令"
```

---

### Task 3: Docker 部署入口

**Files:**
- Modify: `deploy/docker/ktv.sh`
- Modify: `deploy/docker/README.md`
- Modify: `docs/KTV-FULL-INDEX.md`
- Modify: `docs/KTV-FULL-INDEX-INTEGRATION.md`

**Step 1: 写脚本行为测试或最小 shell 静态测试**

如果现有部署脚本没有测试框架，至少新增或扩展文档型验证命令，确保 `ktv.sh help` 展示 `probe-index`。

**Step 2: 实现 `probe-index`**

命令形式：

```bash
bash deploy/docker/ktv.sh probe-index -- --limit 300 --concurrency 2
```

内部执行：

```bash
docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" exec api \
  pnpm -F @home-ktv/api probe:ktv-index -- "$@"
```

**Step 3: 更新文档**

写明：

- 先 300 首样本。
- 样本通过后全量高并发。
- 失败不影响点歌。
- 不保存 raw ffprobe。

**Step 4: 本地验证**

```bash
bash deploy/docker/ktv.sh help
```

Expected: 输出包含 `probe-index`。

**Step 5: 提交**

```bash
git add deploy/docker/ktv.sh deploy/docker/README.md docs/KTV-FULL-INDEX.md docs/KTV-FULL-INDEX-INTEGRATION.md
git commit -m "补充音轨探测部署入口"
```

---

### Task 4: 诊断指标与 doctor 展示

**Files:**
- Modify: `packages/domain/src/index.ts`
- Modify: `apps/api/src/modules/ktv-index/ktv-index-read-repository.ts`
- Modify: `apps/api/src/test/ktv-index-read-repository.test.ts`
- Modify: `scripts/tools/deploy-doctor.mjs`
- Modify: `scripts/tools/deploy-doctor.test.mjs`

**Step 1: 写失败测试**

在 repository 测试中断言 diagnostics 返回：

- `technicalStatusCounts`
- `audioTrackDistribution`
- `probePendingCount`
- `probeFailedCount`
- `probeCoveragePercent`

在 doctor 测试中断言输出包含：

- `probed=`
- `pending=`
- `failed=`
- `tracks:1=`

**Step 2: 运行失败测试**

```bash
pnpm -F @home-ktv/api exec vitest run src/test/ktv-index-read-repository.test.ts
node --test scripts/tools/deploy-doctor.test.mjs
```

Expected: FAIL。

**Step 3: 实现指标**

SQL 使用 `jsonb_array_length(coalesce(...))` 统计音轨数量。不要把状态判断复杂化，只返回原始数字。

**Step 4: 运行测试**

```bash
pnpm -F @home-ktv/api exec vitest run src/test/ktv-index-read-repository.test.ts
node --test scripts/tools/deploy-doctor.test.mjs
```

Expected: PASS。

**Step 5: 提交**

```bash
git add packages/domain/src/index.ts apps/api/src/modules/ktv-index/ktv-index-read-repository.ts apps/api/src/test/ktv-index-read-repository.test.ts scripts/tools/deploy-doctor.mjs scripts/tools/deploy-doctor.test.mjs
git commit -m "展示音轨探测指标"
```

---

### Task 5: 全量验证与部署

**Files:**
- No production code expected.

**Step 1: 本地全量验证**

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm repo:hygiene -- --fail-on-dirty
```

Expected: PASS。

**Step 2: 推送**

```bash
git push
```

**Step 3: 部署到 lxc-dev**

```bash
ssh lxc-dev 'cd /opt/home-ktv-system && git pull --ff-only && bash deploy/docker/ktv.sh restart && bash deploy/docker/ktv.sh doctor'
```

Expected: doctor PASS。

**Step 4: 跑 300 首样本**

```bash
ssh lxc-dev 'cd /opt/home-ktv-system && bash deploy/docker/ktv.sh probe-index -- --limit 300 --concurrency 2'
```

记录：

- 总耗时
- 成功数量
- 失败数量
- 单音轨数量
- 双音轨数量
- 多音轨数量

**Step 5: 样本后检查 doctor**

```bash
ssh lxc-dev 'cd /opt/home-ktv-system && bash deploy/docker/ktv.sh doctor'
```

Expected: doctor PASS，并展示探测覆盖率和音轨分布。

**Step 6: 全量高并发**

如果 300 首样本失败率可接受：

```bash
ssh lxc-dev 'cd /opt/home-ktv-system && bash deploy/docker/ktv.sh probe-index -- --concurrency 8 --retry-failed'
```

如果服务器 I/O 和 CPU 余量充足，再考虑提高到 `12` 或 `16`。

**Step 7: UAT**

在控制端搜索真实歌曲，确认：

- 双音轨歌曲不显示“单音轨歌曲源”。
- 单音轨歌曲显示“单音轨歌曲源”。
- failed/unknown 探测资源仍然可以点歌。

**Step 8: 最终提交部署证据**

如有文档更新：

```bash
git add docs/KTV-FULL-INDEX.md docs/KTV-FULL-INDEX-INTEGRATION.md
git commit -m "记录音轨探测结果"
git push
```
