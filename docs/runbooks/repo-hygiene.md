# 仓库卫生 Runbook

## 目标

仓库应当能清楚区分三类内容：

- 正式产品代码、迁移、脚本和文档：需要提交并推送。
- 本地运行产物和临时调研产物：需要忽略，不进入 Git。
- 需要产品或架构决策的高风险文件：先保留在工作区，明确记录后再处理。

## 检查命令

```bash
pnpm repo:hygiene
```

发布或部署前建议使用失败模式：

```bash
pnpm repo:hygiene -- --fail-on-dirty
```

## 当前规则

以下目录属于本地或生成内容，默认不提交：

- `runtime/`
- `logs/`
- `home-ktv-media/`
- `songs-sample/`
- `.codex/`
- `.planning/reports/`
- `.worktrees/`
- `worktrees/`

`apps/`、`clients/`、`packages/`、`deploy/`、`scripts/`、`docs/` 下的未跟踪文件会被视为高风险，因为它们很可能影响构建、部署或产品行为。

## 处理流程

1. 先运行 `pnpm repo:hygiene`。
2. 如果出现 tracked dirty，确认是否属于当前任务；不属于当前任务就不要提交。
3. 如果出现 high-risk untracked，判断它是正式能力还是临时产物。
4. 正式能力必须补齐测试、文档和验证后提交。
5. 临时产物应移动到已忽略目录，或者补充 `.gitignore` 规则。
6. 需要产品决策的文件不要擅自删除或提交，记录到计划或 runbook 后等待确认。

## 长期代码规则

每隔一段功能开发后做一次提交前 review。检查重点固定为：

- 模块边界清楚：API route 只做协议校验和编排，领域算法放到可测试函数或服务，UI 组件不直接绕过 runtime 调后端。
- 类型边界清楚：跨包数据结构优先定义在 `packages/domain` 或 `packages/player-contracts`，避免在应用内重复手写相同 shape。
- 不引入低价值抽象：只有在减少真实重复、隔离模块边界或稳定测试入口时才抽函数/组件。
- 不提交临时产物：IDE workspace、运行日志、调试数据、截图和本地生成目录不进入 Git。
- 不用 `any` 逃避类型：确实需要接未知外部输入时用 `unknown`，在边界处收窄。
- UI 变更必须配套可回归的行为测试；涉及 TV/控制端联动时，至少覆盖协议、runtime 和展示层中的关键路径。
- 提交前至少运行受影响包的测试和构建；改动跨包协议时优先跑 API、controller、tv-web 的相关测试。
- 每次重新编译部署 Web TV / Controller / API 后，必须先跑 `pnpm deploy:smoke -- ...` 验证 CORS、TV bootstrap/heartbeat、控制端看到 TV 在线、推荐列表非空，再通知测试。

## 真实歌库索引

KTV full-index 相关迁移、脚本、测试和文档属于正式能力，原因是它们让 `/mnt/nas/KTV歌曲` 的真实歌库索引可以从 Git 拉取后重新建立：

- `apps/api/src/db/migrations/0008_ktv_full_index.sql`
- `apps/api/src/db/migrations/0009_ktv_active_asset_indexes.sql`
- `apps/api/src/modules/ingest/ktv-sample-index.ts`
- `apps/api/src/modules/ingest/ktv-full-index.ts`
- `apps/api/src/scripts/ktv-sample-index.ts`
- `apps/api/src/scripts/ktv-full-index.ts`
- `docs/KTV-FULL-INDEX.md`
- `docs/KTV-FULL-INDEX-INTEGRATION.md`

验证命令：

```bash
pnpm -F @home-ktv/api exec vitest run src/test/ktv-sample-index.test.ts src/test/ktv-full-index.test.ts
pnpm -F @home-ktv/api typecheck
```
