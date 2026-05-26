# Project Structure And Deployment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 整理 HomeKTV 项目结构，并提供 Docker Compose 与源码两套服务器部署入口。

**Architecture:** 源码按产品域组织：`apps` 放 Web/API 应用，`clients` 放原生客户端，`packages` 放共享包，`deploy` 放服务器部署，`scripts` 放开发和工具脚本。Docker 部署用 Compose 管理 Postgres/API/Admin/Controller；源码部署用 pnpm build + 后台进程管理运行 API 和 Vite preview 静态站。

**Tech Stack:** pnpm workspace、Turborepo、Fastify、Vite/React、Kotlin Android、Docker Compose、Nginx、Bash/Node.js 部署脚本。

---

## Task List

### Task 1: Record Design And Plan

**Files:**
- Create: `docs/plans/2026-05-26-project-structure-deployment-design.md`
- Create: `docs/plans/2026-05-26-project-structure-deployment.md`

**Steps:**
1. Save the approved architecture and deployment design.
2. Save this implementation plan and task list.
3. Commit with a short Chinese message.

**Verify:**

```bash
git diff --check -- docs/plans/2026-05-26-project-structure-deployment-design.md docs/plans/2026-05-26-project-structure-deployment.md
```

### Task 2: Restructure Product Directories

**Files:**
- Move: `HomeKTV/` -> `clients/android-tv/`
- Move: `apps/mobile-controller/` -> `apps/controller/`
- Move: `apps/tv-player/` -> `apps/tv-web/`
- Modify: `pnpm-workspace.yaml`
- Modify: `package.json`
- Modify: `scripts/dev/dev-local.mjs`
- Modify: docs and README references

**Steps:**
1. Move directories with git-aware moves.
2. Rename package names to `@home-ktv/controller` and `@home-ktv/tv-web`.
3. Update root scripts and local dev script filters.
4. Keep user-facing command aliases such as `pnpm dev:local`.
5. Update all path references from old locations to new locations.

**Verify:**

```bash
rg -n "HomeKTV|mobile-controller|tv-player" README.md docs apps packages scripts deploy clients package.json pnpm-workspace.yaml
pnpm install --lockfile-only
pnpm typecheck
```

### Task 3: Reorganize Scripts

**Files:**
- Move: `scripts/dev-local.*` -> `scripts/dev/`
- Move tools to `scripts/tools/`
- Modify: `package.json`
- Modify: docs

**Steps:**
1. Put local dev script under `scripts/dev/`.
2. Put demo/visual/risk scripts under `scripts/tools/`.
3. Preserve root pnpm command names.
4. Add deployment command aliases for Docker and source modes.

**Verify:**

```bash
pnpm dev:local help
pnpm ui:visual-check:test
```

### Task 4: Implement Docker Compose Deployment

**Files:**
- Create: `deploy/docker/compose.yml`
- Create: `deploy/docker/Dockerfile.api`
- Create: `deploy/docker/Dockerfile.web`
- Create: `deploy/docker/nginx-spa.conf`
- Create: `deploy/docker/ktv.sh`
- Create: `deploy/env/server.env.example`
- Create: `deploy/docker/README.md`

**Steps:**
1. Build API image from workspace and start with migration then `node apps/api/dist/server.js`.
2. Build Admin and Controller static images with `VITE_API_BASE_URL`.
3. Mount media and NAS paths through env-driven volumes.
4. Implement `setup/start/restart/status/logs/stop/pull/build` commands.
5. Document first deploy and update deploy flows.

**Verify:**

```bash
bash deploy/docker/ktv.sh help
docker compose --env-file deploy/env/server.env.example -f deploy/docker/compose.yml config
```

### Task 5: Implement Source Deployment

**Files:**
- Create: `deploy/source/ktv.sh`
- Create: `deploy/source/ktv-source.mjs`
- Create: `deploy/source/README.md`
- Modify: app package `preview` scripts

**Steps:**
1. Implement `setup` as install + build + migrate.
2. Implement `start/restart/stop/status/logs` with pid/log files under `runtime/`.
3. Start API from built dist and Admin/Controller via Vite preview.
4. Load `.env` from `deploy/source/.env` or `deploy/env/server.env`.
5. Ensure migration runs before API start.

**Verify:**

```bash
bash deploy/source/ktv.sh help
bash deploy/source/ktv.sh status
```

### Task 6: Update Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/project-structure.md`
- Split or rewrite: `docs/deployment.md`
- Create: `docs/deployment-local.md`
- Create: `docs/deployment-docker.md`
- Create: `docs/deployment-source.md`
- Modify: app READMEs

**Steps:**
1. Make root README the primary map.
2. Move local dev details into `docs/deployment-local.md`.
3. Put Docker server deploy in `docs/deployment-docker.md`.
4. Put source server deploy in `docs/deployment-source.md`.
5. Keep `docs/deployment.md` as deployment index.

**Verify:**

```bash
rg -n "clients/android-tv|apps/controller|apps/tv-web|deploy/docker|deploy/source" README.md docs
```

### Task 7: Final Verification And Commit

**Files:**
- All changed files

**Steps:**
1. Run targeted script checks.
2. Run API/Mobile/Admin/Android path-sensitive builds if feasible.
3. Check git status and ensure unrelated dirty files are not included.
4. Commit with a short Chinese message and push to `origin/main`.

**Verify:**

```bash
git diff --check
pnpm typecheck
pnpm build
cd clients/android-tv && ./gradlew :app:testDebugUnitTest :app:assembleDebug --no-daemon
git status --short
```
