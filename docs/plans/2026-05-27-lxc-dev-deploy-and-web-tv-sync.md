# LXC Dev Deploy And Web TV Sync Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deploy HomeKTV on `lxc-dev`, expose it through Caddy/Homepage, and make Web TV the primary development TV client aligned with Android TV.

**Architecture:** Run HomeKTV server-side services on `lxc-dev` with Docker Compose. Expose API, Admin, Controller, and Web TV through `lxc-network` Caddy using dedicated subdomains. Keep Android TV as the real-device playback client while Web TV becomes the fast development and UI validation client.

**Tech Stack:** Docker Compose, Caddy, Homepage, pnpm workspace, Vite React Web TV, Fastify API, PostgreSQL.

---

### Task 1: Deploy HomeKTV On lxc-dev

**Files:**
- Remote create/update: `lxc-dev:/opt/home-ktv-system`
- Remote create/update: `lxc-dev:/opt/home-ktv-system/deploy/docker/.env`

**Steps:**
1. Clone or update `git@github.com:ShaoLongFei/home-ktv-system.git` under `/opt/home-ktv-system`.
2. Create `deploy/docker/.env` from `deploy/env/server.env.example` if absent.
3. Set:
   - `PUBLIC_BASE_URL=https://ktv-api.shaolongfei.com`
   - `CONTROLLER_BASE_URL=https://ktv-controller.shaolongfei.com`
   - `CORS_ALLOWED_ORIGINS=https://ktv-admin.shaolongfei.com,https://ktv-controller.shaolongfei.com,https://ktv-tv.shaolongfei.com`
   - `API_PORT=4000`
   - `ADMIN_PORT=5174`
   - `CONTROLLER_PORT=5176`
   - `TV_WEB_PORT=5173`
4. Start with `bash deploy/docker/ktv.sh start`.
5. Verify `http://127.0.0.1:4000/health` and Compose status.

### Task 2: Add Web TV To Docker Deployment If Missing

**Files:**
- Modify: `deploy/docker/compose.yml`
- Modify: `deploy/env/server.env.example`
- Modify: `deploy/docker/README.md`
- Modify: `docs/deployment-docker.md`

**Steps:**
1. Add `tv-web` service using `Dockerfile.web`.
2. Expose `${TV_WEB_PORT:-5173}:80`.
3. Include `https://ktv-tv.shaolongfei.com` in deployment docs and CORS examples.
4. Run `KTV_ENV_FILE=deploy/env/server.env.example bash deploy/docker/ktv.sh config`.
5. Commit with a short Chinese message and push.

### Task 3: Configure Caddy And Homepage

**Files:**
- Remote modify: `lxc-network:/etc/caddy/Caddyfile`
- Remote modify: `lxc-network:/opt/homepage/config/services.yaml`

**Steps:**
1. Back up both files with timestamp suffix.
2. Add Caddy handlers:
   - `ktv-api.shaolongfei.com -> 192.168.5.102:4000`
   - `ktv-admin.shaolongfei.com -> 192.168.5.102:5174`
   - `ktv-controller.shaolongfei.com -> 192.168.5.102:5176`
   - `ktv-tv.shaolongfei.com -> 192.168.5.102:5173`
3. Validate with `caddy validate --config /etc/caddy/Caddyfile`.
4. Reload Caddy.
5. Add Homepage group `家庭 KTV` with Admin, Controller, Web TV, API health entries.
6. Verify public URLs with `curl -I`.

### Task 4: Web TV UI Alignment

**Files:**
- Modify: `apps/tv-web/src/screens/IdleScreen.tsx`
- Modify: `apps/tv-web/src/screens/PlayingScreen.tsx`
- Modify: `apps/tv-web/src/components/PairingQr.tsx`
- Modify tests under `apps/tv-web/src/test/`

**Steps:**
1. Keep the Android TV behavior model: idle screen shows large QR on the right, premium visual area on the left; playing screen stays clean with bottom-left time/audio info and a corner QR.
2. Use a dark OLED entertainment design system with high-contrast text and restrained green/cyan status accents.
3. Avoid text-heavy instructions and decorative cards inside cards.
4. Add/adjust tests for idle QR layout copy and playing overlay essentials.
5. Run `pnpm -F @home-ktv/tv-web test`, `pnpm -F @home-ktv/tv-web typecheck`, and `pnpm -F @home-ktv/tv-web build`.

### Task 5: Redeploy And Verify

**Files:**
- Remote update: `lxc-dev:/opt/home-ktv-system`

**Steps:**
1. Push local changes.
2. Pull on `lxc-dev`.
3. Rebuild/restart Docker deployment.
4. Verify:
   - `https://ktv-api.shaolongfei.com/health`
   - `https://ktv-admin.shaolongfei.com/`
   - `https://ktv-controller.shaolongfei.com/controller?room=living-room`
   - `https://ktv-tv.shaolongfei.com/?apiBaseUrl=https://ktv-api.shaolongfei.com&roomSlug=living-room&deviceName=Web%20TV`
5. Provide test URLs and current caveats.
