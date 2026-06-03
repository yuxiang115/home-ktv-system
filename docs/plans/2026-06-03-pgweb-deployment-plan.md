# pgweb Deployment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deploy a lightweight web PostgreSQL browser (`pgweb`) on `lxc-dev`, expose it through existing Caddy and Homepage on `lxc-network`, and document the setup.

**Architecture:** `pgweb` runs as an independent systemd service on `lxc-dev` and reuses the existing HomeKTV `DATABASE_URL` from `deploy/source/.env`. `lxc-network` terminates TLS in the shared wildcard Caddy config and forwards `pgweb.shaolongfei.com` to `192.168.5.102:8082`, while Homepage gets a simple link entry.

**Tech Stack:** pgweb binary release, systemd, Caddy, Homepage YAML, Markdown docs

---

### Task 1: Record the approved deployment design

**Files:**
- Create: `docs/plans/2026-06-03-pgweb-deployment-design.md`
- Create: `docs/plans/2026-06-03-pgweb-deployment-plan.md`

**Step 1: Save the approved design and implementation plan**

- Capture host topology
- Capture chosen port `8082`
- Capture domain `pgweb.shaolongfei.com`
- Capture the reuse of the existing `DATABASE_URL`

### Task 2: Install and configure `pgweb` on `lxc-dev`

**Files:**
- Remote create: `/opt/pgweb/pgweb`
- Remote create: `/etc/systemd/system/pgweb.service`

**Step 1: Download the official Linux binary**

- Create `/opt/pgweb`
- Download and extract the latest stable Linux AMD64 release
- Make the binary executable

**Step 2: Write the systemd service**

- Reuse `/opt/home-ktv-system/deploy/source/.env`
- Bind to `0.0.0.0:8082`
- Use `Restart=always`

**Step 3: Start and enable the service**

- `systemctl daemon-reload`
- `systemctl enable --now pgweb`

**Step 4: Verify locally on `lxc-dev`**

- `systemctl status pgweb --no-pager`
- `curl -I http://127.0.0.1:8082`

### Task 3: Add Caddy reverse proxy on `lxc-network`

**Files:**
- Remote modify: `/etc/caddy/Caddyfile`

**Step 1: Backup the current config**

- Copy the current Caddyfile with a timestamp

**Step 2: Add the new host mapping**

- Add `@pgweb host pgweb.shaolongfei.com`
- Reverse proxy to `192.168.5.102:8082`

**Step 3: Validate and reload**

- `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`
- `systemctl reload caddy`

### Task 4: Add Homepage entry

**Files:**
- Remote modify: `/opt/homepage/config/services.yaml`

**Step 1: Backup the config**

- Copy `services.yaml` with a timestamp

**Step 2: Add the service entry**

- Add `pgweb` under `工具`
- Link to `https://pgweb.shaolongfei.com`
- Add a concise description

**Step 3: Reload Homepage if needed**

- If Homepage picks up config automatically, no restart
- Otherwise restart the Homepage service/container

### Task 5: Update docs

**Files:**
- Modify: `docs/runbooks/deploy-lxc-dev.md`
- Modify: `/Users/shaolongfei/Desktop/我的项目/服务器部署规划/06-应用服务.md`

**Step 1: Update project deployment runbook**

- Add a short `pgweb` section under Caddy/Homepage or service inventory

**Step 2: Update the external server service record**

- Add install path, service name, domain, port, management commands, and Caddy/Homepage notes

### Task 6: End-to-end verification

**Files:**
- None

**Step 1: Verify service health**

- `ssh dev 'systemctl status pgweb --no-pager'`

**Step 2: Verify reverse proxy**

- `curl -I https://pgweb.shaolongfei.com`

**Step 3: Verify Homepage entry**

- Confirm the Homepage config contains the new `pgweb` entry

**Step 4: Commit and push local doc changes**

- Commit only the local documentation changes
