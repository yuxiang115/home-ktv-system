# 服务器源码部署切换 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将服务器默认部署路径切换为源码部署，并提供适合高频测试的一键部署命令。

**Architecture:** 保留现有 `deploy/source` 脚本作为主入口，新增 `deploy` 与 `smoke` 命令。`deploy` 串联拉代码、安装依赖、构建、迁移、重启、doctor 和 smoke；文档把 `lxc-dev` 的主路径从 Docker Compose 改为源码部署。

**Tech Stack:** Node.js 脚本、Bash 包装脚本、Markdown runbook、Node test。

---

### Task 1: 写失败测试

**Files:**
- Create: `scripts/tools/source-deployment-docs.test.mjs`

**Steps:**

1. 断言 `bash deploy/source/ktv.sh help` 输出包含 `deploy` 和 `smoke`。
2. 断言 `docs/deployment.md` 推荐服务器优先使用源码部署。
3. 断言 `docs/runbooks/deploy-lxc-dev.md` 使用 `bash deploy/source/ktv.sh deploy`。
4. 运行 `node --test scripts/tools/source-deployment-docs.test.mjs`，确认失败。

### Task 2: 实现源码部署命令

**Files:**
- Modify: `deploy/source/ktv-source.mjs`
- Modify: `deploy/source/README.md`

**Steps:**

1. 新增 `deploy` 命令：`pull -> install -> build -> restart services -> doctor -> smoke`。
2. 新增 `smoke` 命令：读取源码部署 `.env`，执行 `scripts/tools/web-deploy-smoke.mjs`。
3. 让 `doctor` 带上源码服务状态命令。
4. 更新 help 和 README。
5. 运行 Task 1 测试，确认通过。

### Task 3: 更新服务器部署文档

**Files:**
- Modify: `docs/deployment.md`
- Modify: `docs/deployment-source.md`
- Modify: `docs/runbooks/deploy-lxc-dev.md`
- Modify: `deploy/README.md`

**Steps:**

1. 把源码部署列为服务器推荐路径。
2. 把 Docker Compose 改成稳定发布和备用路径。
3. 在 `lxc-dev` runbook 中记录从 Docker 切换到源码部署的步骤。
4. 更新部署后 smoke 检查命令。

### Task 4: 验证与提交

**Commands:**

```bash
node --test scripts/tools/source-deployment-docs.test.mjs
node --test scripts/tools/deploy-doctor.test.mjs scripts/tools/web-deploy-smoke.test.mjs
bash deploy/source/ktv.sh help
git diff --check
```

**Commit:**

```bash
git add deploy docs scripts/tools/source-deployment-docs.test.mjs
git commit -m "chore: switch server deployment to source"
```
