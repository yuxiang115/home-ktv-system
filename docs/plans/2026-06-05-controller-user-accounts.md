# Controller User Accounts Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add simple controller login/register and tie queued songs/history to the logged-in person.

**Architecture:** Add controller user and auth-session repositories in the API, require auth for controller sessions and commands, and persist requester user snapshots on queue entries. The controller app gates its main UI behind auth and exposes login, register, logout, profile edit, and personal history.

**Tech Stack:** Fastify, TypeScript, PostgreSQL SQL migrations, React, Vitest, Testing Library.

---

### Task 1: API Auth Contract Tests

**Files:**
- Create: `apps/api/src/test/controller-auth-routes.test.ts`
- Modify: `apps/api/src/server.ts`

**Steps:**
1. Write failing tests for register, login, me, logout, duplicate phone, short password, and display-name update.
2. Run `pnpm --filter @home-ktv/api test apps/api/src/test/controller-auth-routes.test.ts`.
3. Implement auth routes, services, and repositories.
4. Run the same API test until it passes.

### Task 2: Database Schema

**Files:**
- Create: `apps/api/src/db/migrations/0024_controller_user_accounts.sql`
- Modify: `apps/api/src/db/schema.ts`

**Steps:**
1. Add failing schema assertions for `controller_users`, `controller_auth_sessions`, `room_clients.user_phone`, and queue requester columns.
2. Add migration and schema SQL.
3. Run API schema tests.

### Task 3: Queue Attribution

**Files:**
- Modify: `packages/domain/src/index.ts`
- Modify: `packages/player-contracts/src/index.ts`
- Modify: `apps/api/src/modules/playback/repositories/queue-entry-repository.ts`
- Modify: `apps/api/src/modules/playback/session-command-service.ts`
- Modify: `apps/api/src/modules/rooms/build-control-snapshot.ts`

**Steps:**
1. Write failing tests proving add-queue-entry stores `requestedByUserPhone` and `requestedByName`.
2. Implement queue repository and snapshot mapping.
3. Run queue and command route tests.

### Task 4: Controller Auth Gate UI

**Files:**
- Modify: `apps/controller/src/api/client.ts`
- Modify: `apps/controller/src/runtime/use-room-controller-runtime.ts`
- Modify: `apps/controller/src/App.tsx`
- Modify: `apps/controller/src/App.css`
- Modify: `apps/controller/src/test/controller.test.tsx`

**Steps:**
1. Write failing tests for unauthenticated login/register screen, successful login, logout, and no guest song browsing.
2. Add controller auth client methods and runtime state.
3. Build the login/register/profile UI using compact mobile-first styling.
4. Run controller tests.

### Task 5: Verification, Commit, Deploy

**Files:**
- All changed files.

**Steps:**
1. Run `pnpm -r typecheck`.
2. Run `pnpm -r test`.
3. Commit implementation.
4. Push to remote.
5. Deploy to lxc-dev and run doctor/smoke.
