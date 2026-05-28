# Style Tagging Job Runner Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Run full-library style tagging as an independent Docker job that survives main service redeploys.

**Architecture:** Add a Node-based deployment helper that starts a standalone `home-ktv-api:latest` job container on the Compose network and stores state/logs under `/opt/home-ktv-jobs/style-tagging`. Keep `deploy/docker/ktv.sh` as the public entry point.

**Tech Stack:** Node.js `node:test`, Docker CLI, existing API image, existing JSONL tagging scripts.

---

### Task 1: Runner Tests

**Files:**
- Create: `scripts/tools/style-tagging-job.test.mjs`
- Create: `scripts/tools/style-tagging-job.mjs`

**Step 1: Write failing tests**

Cover:
- default CLI values for job root, network, container name, concurrency, and input path
- `.env` parsing and default media/NAS paths
- Docker run args include a standalone container, job root mount, media mount, Docker network, and JSONL tagging command
- container path to host path conversion for `stats`
- JSONL stats summary

**Step 2: Run tests and confirm failure**

```bash
node --test scripts/tools/style-tagging-job.test.mjs
```

Expected: fail because the runner module is missing or behavior is not implemented.

### Task 2: Runner Implementation

**Files:**
- Create/modify: `scripts/tools/style-tagging-job.mjs`

**Step 1: Implement parsing and command builders**

Implement pure functions first:
- `parseArgs`
- `parseEnvText`
- `resolveDeploymentEnv`
- `containerPathToHostPath`
- `summarizeResultsText`
- `buildDockerRunArgs`
- `buildImportRunArgs`

**Step 2: Implement command execution**

Implement:
- `start`
- `resume`
- `status`
- `logs`
- `stop`
- `stats`
- `import-dry-run`
- `import`

Use dependency injection for command execution where practical.

**Step 3: Run tests**

```bash
node --test scripts/tools/style-tagging-job.test.mjs
```

Expected: pass.

### Task 3: Deployment Entry and Docs

**Files:**
- Modify: `deploy/docker/ktv.sh`
- Modify: `deploy/docker/README.md`
- Modify: `docs/deployment-docker.md`
- Modify: `docs/KTV-FULL-INDEX.md`
- Modify: `docs/KTV-FULL-INDEX-INTEGRATION.md`
- Modify: `README.md`

**Step 1: Add CLI entry**

Add:

```bash
bash deploy/docker/ktv.sh tag-styles-job <command>
```

**Step 2: Update docs**

Document the preferred long-running style tagging flow:

```bash
bash deploy/docker/ktv.sh tag-styles-job resume
bash deploy/docker/ktv.sh tag-styles-job status
bash deploy/docker/ktv.sh tag-styles-job logs
bash deploy/docker/ktv.sh tag-styles-job stats
```

### Task 4: Verification and Server Cutover

**Step 1: Run local verification**

```bash
node --test scripts/tools/style-tagging-job.test.mjs
pnpm repo:hygiene
git diff --check
```

**Step 2: Commit and push**

Use a short Chinese commit message.

**Step 3: Deploy to `lxc-dev`**

Pull latest code, stop the fragile `compose exec` tagging process if it is still
running, then resume the same output file using the independent job runner.

**Step 4: Verify on server**

Confirm:
- standalone container exists
- line count grows
- `tag-styles-job stats` reports valid JSONL counts
- main-service restart does not stop the job, if a restart is needed later
