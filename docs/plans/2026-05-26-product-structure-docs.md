# Product Structure Documentation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the repository understandable as a product with three primary parts: backend/admin, TV, and controller.

**Architecture:** Keep existing source paths stable to avoid breaking pnpm, Turbo, Android Gradle, and local deployment scripts. Add product-facing README files at each entry point, central deployment documentation, and a project structure guide. Consolidate hot-song documentation into `packages/hot-songs/README.md` and keep `docs/HOT-SONGS.md` as a compatibility pointer.

**Tech Stack:** Node.js/pnpm/Turbo, Fastify/PostgreSQL, Vite React apps, Android Kotlin/libVLC, shell/Node local deployment scripts.

---

### Task 1: Root Navigation

**Files:**
- Create: `README.md`
- Create: `docs/project-structure.md`

**Steps:**
1. Document the three product areas and their source paths.
2. Link to deployment, backend/admin, TV, controller, and hot-song docs.
3. Mark local-only runtime folders such as `home-ktv-media/`, `logs/`, and `songs-sample/`.

### Task 2: Product Entry README Files

**Files:**
- Create: `apps/api/README.md`
- Create: `apps/admin/README.md`
- Create: `HomeKTV/README.md`
- Create: `apps/mobile-controller/README.md`
- Create: `apps/tv-player/README.md`

**Steps:**
1. Explain each module's responsibility.
2. List core commands and required environment variables.
3. Clarify production vs legacy/debug status where relevant.

### Task 3: Deployment Documentation

**Files:**
- Create: `docs/deployment.md`

**Steps:**
1. Document local deployment with `pnpm dev:local start|restart|status|tail|stop`.
2. Document PostgreSQL, media path, LAN URL, Android TV APK install, and verification.
3. Include troubleshooting pointers for TV online status, controller QR, NAS media, and logs.

### Task 4: Hot Songs Documentation

**Files:**
- Create: `packages/hot-songs/README.md`
- Modify: `docs/HOT-SONGS.md`

**Steps:**
1. Move the operational hot-song guide to the package README.
2. Keep the old docs page as a short redirect to the canonical package README.

### Task 5: Verify and Commit

**Commands:**
- `git diff --check`
- `git status --short`

**Commit:**
- `整理产品化项目文档`
