# Python Song Cover Cache Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 用 Python 脚本批量补齐 NAS 歌曲封面，把图片下载到本地缓存，并把 `ktv_songs.cover_image_url` 写成本地公开 URL。

**Architecture:** Python 脚本通过 `psql` 读取和更新 `ktv_songs`，通过国内音乐源搜索封面，下载到 `MEDIA_ROOT/covers/nas/<song-id>.jpg`，并用 JSONL/state 文件记录进度。API 增加 `/media/covers/nas/:songId` 静态图片读取路由，控制端继续消费已有 `coverImageUrl` 字段。

**Tech Stack:** Python 3 标准库、PostgreSQL `psql`、Fastify media route、Vitest、node:test、pnpm/turbo。

---

### Task 1: Python Script Tests

**Files:**
- Create: `scripts/tools/fetch_song_covers_test.py`

**Steps:**
1. Add tests for local cover path and public URL generation.
2. Add tests for fetch decision logic: skip completed, repair DB when file exists, retry failed only when requested.
3. Add tests for cover matching: exact song/artist wins, DJ/Live variants are penalized.
4. Run `python3 scripts/tools/fetch_song_covers_test.py`; expected RED because `scripts/tools/fetch_song_covers.py` does not exist.

### Task 2: Python Script Implementation

**Files:**
- Create: `scripts/tools/fetch_song_covers.py`

**Steps:**
1. Implement CLI subcommands: `fetch`, `coverage`, `status`.
2. Implement `.env` loading and `psql` command detection, following `run_style_tagging_llm_batch.py` patterns.
3. Implement candidate selection from `ktv_songs` with `missing_at is null`.
4. Implement JSONL history/state reading and writing.
5. Implement local cache paths under `<media-root>/covers/nas`.
6. Implement Tencent, Kugou, and Kuwo search/image lookup with Python `urllib`.
7. Implement image download with atomic write and basic image validation.
8. Implement DB update SQL for found, not_found, failed, and repair cases.
9. Run `python3 scripts/tools/fetch_song_covers_test.py`; expected GREEN.

### Task 3: API Cover Media Route

**Files:**
- Modify: `apps/api/src/routes/media.ts`
- Modify: `apps/api/src/server.ts`
- Create: `apps/api/src/test/song-cover-media-route.test.ts`

**Steps:**
1. Write a Vitest route test for `GET /media/covers/nas/:songId`.
2. Verify RED with `pnpm -F @home-ktv/api test -- src/test/song-cover-media-route.test.ts`.
3. Add `coverRoot` to `registerMediaRoutes` context.
4. Implement safe song-id validation and JPEG file streaming.
5. Wire `coverRoot = path.join(resolvedConfig.mediaRoot, "covers")` in `server.ts`.
6. Run the route test; expected GREEN.

### Task 4: Command Entrypoints And Docs

**Files:**
- Modify: `package.json`
- Modify: `apps/api/package.json`
- Modify: `deploy/docker/Dockerfile.api`
- Modify: `deploy/docker/ktv.sh`
- Modify: `docs/runbooks/song-cover-fetching.md`
- Modify: `docs/deployment-source.md`
- Modify: `docs/deployment-docker.md`

**Steps:**
1. Change `covers:songs` and `covers:coverage` to call Python script.
2. Ensure Docker API image has `python3` and `postgresql-client`.
3. Update Docker wrapper commands to keep existing `fetch-covers` and `cover-coverage` names.
4. Update Chinese runbook with local cache path, JSONL progress, retry flags, and status command.

### Task 5: Verification And Commit

**Commands:**
- `python3 scripts/tools/fetch_song_covers_test.py`
- `pnpm -F @home-ktv/api test -- src/test/song-cover-media-route.test.ts src/test/song-discovery-routes.test.ts`
- `pnpm typecheck`
- `pnpm build`
- `git diff --check`

**Steps:**
1. Run all commands above.
2. Review `rg "song-covers.ts|song-cover-coverage.ts|song-cover-cache" package.json apps docs deploy scripts`.
3. Commit with message `改用 Python 缓存歌曲封面`。
4. Merge to `main` and push after verification.
