# Productization Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make HomeKTV easier to deploy, diagnose, and maintain after the move to real NAS media and Android/Web TV dual-client workflow.

**Architecture:** Add lightweight scripts and docs around the existing monorepo instead of introducing new infrastructure. Docker and source deployment should share one doctor script. Repository hygiene should be reported, not auto-mutated.

**Tech Stack:** Node.js built-in modules, bash deployment wrappers, Docker Compose, pnpm workspace, existing docs.

---

### Task 1: Add Shared Deployment Doctor

**Files:**
- Create: `scripts/tools/deploy-doctor.mjs`
- Create: `scripts/tools/deploy-doctor.test.mjs`
- Modify: `package.json`
- Modify: `deploy/docker/ktv.sh`
- Modify: `deploy/source/ktv-source.mjs`

**Steps:**
1. Add a Node script that loads an env file, builds a deployment config, checks required variables, checks NAS path readability, probes URLs, optionally runs `docker compose ps`, and prints a compact PASS/WARN/FAIL report.
2. Make the script accept `--mode docker|source`, `--env-file`, `--skip-network`, `--json`, and `--service-status-cmd`.
3. Add tests for env parsing, URL derivation, CORS coverage, path mapping checks, and report severity.
4. Add `pnpm deploy:doctor` root command.
5. Add `doctor` command to Docker and source deployment wrappers.

### Task 2: Add Repository Hygiene Check

**Files:**
- Create: `scripts/tools/repo-hygiene-check.mjs`
- Create: `scripts/tools/repo-hygiene-check.test.mjs`
- Modify: `package.json`
- Modify: `README.md`

**Steps:**
1. Add a script that reports dirty tracked files, untracked high-risk paths, ignored runtime paths, and branch sync metadata when available.
2. Keep behavior read-only.
3. Add tests using a temporary git repo.
4. Add `pnpm repo:hygiene` root command.
5. Document when to run it.

### Task 3: Document Operations Runbooks

**Files:**
- Create: `docs/runbooks/deploy-lxc-dev.md`
- Create: `docs/runbooks/troubleshooting.md`
- Create: `docs/runbooks/release-checklist.md`
- Modify: `docs/deployment-docker.md`
- Modify: `deploy/docker/README.md`

**Steps:**
1. Record lxc-dev deployment commands and public URLs.
2. Record PVE bind mount for NAS and how to verify it.
3. Record Caddy/Homepage touch points without embedding secrets.
4. Add troubleshooting steps for TV offline, controller offline, media unreadable, empty queue, Web TV browser autoplay, Android TV audio track issues.
5. Add a release checklist that starts with `repo:hygiene`, build/test commands, deploy, `doctor`, and smoke tests.

### Task 4: Verify And Ship

**Files:**
- No new implementation files expected.

**Steps:**
1. Run Node script tests.
2. Run deployment doctor locally against the example env with network skipped.
3. Run repo hygiene in report mode.
4. Run targeted build/typecheck commands for changed packages if needed.
5. Commit with a short Chinese message and push.
6. Pull and run `doctor` on lxc-dev if remote environment is available.

