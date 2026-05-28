# Controller Discovery Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a mobile controller discovery home with search history overlay, artist/genre browsing, and a 30-song weighted recommendation list.

**Architecture:** Add a dedicated discovery API alongside the existing search API. Reuse existing song search result contracts for queueable song cards where possible, and keep search overlay state local to the controller.

**Tech Stack:** Fastify, PostgreSQL query repositories, shared TypeScript domain types, React, Vite, Vitest, Testing Library.

---

### Task 1: Discovery API Contract And Route

**Files:**
- Modify: `packages/domain/src/index.ts`
- Modify: `apps/api/src/modules/catalog/repositories/song-repository.ts`
- Create: `apps/api/src/routes/song-discovery.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/src/test/song-discovery-routes.test.ts`

**Steps:**
1. Write route tests for missing room, recommended results, artist modules, genre modules, and refresh seed calls.
2. Run `pnpm -F @home-ktv/api test -- song-discovery-routes.test.ts` and verify failure because the route does not exist.
3. Add shared discovery response types.
4. Add repository methods that list discoverable formal songs and attach global queue counts.
5. Implement weighted random selection with base weight and deterministic seed input.
6. Register the route in the API server.
7. Run the route test and API typecheck.

### Task 2: Controller Runtime And Client

**Files:**
- Modify: `apps/controller/src/api/client.ts`
- Modify: `apps/controller/src/runtime/use-room-controller-runtime.ts`
- Test: `apps/controller/src/test/controller.test.tsx`

**Steps:**
1. Write runtime tests for loading discovery after session restore and refreshing recommendations with a different seed.
2. Run `pnpm -F @home-ktv/controller test -- controller.test.tsx` and verify failure.
3. Add `fetchSongDiscovery`.
4. Add discovery state, status, refresh action, and error handling to the controller runtime.
5. Run the controller tests.

### Task 3: Controller UI

**Files:**
- Modify: `apps/controller/src/App.tsx`
- Modify: `apps/controller/src/App.css`
- Modify: `apps/controller/src/i18n.tsx`
- Test: `apps/controller/src/test/controller.test.tsx`

**Steps:**
1. Write UI tests for search overlay history, clear history, inline search results, home ordering, artist/genre modules, and the 30-song recommendation section.
2. Run controller tests and verify failure.
3. Refactor reusable song result rendering.
4. Build search overlay and local history helpers.
5. Build artist/genre modules and in-page more/detail states.
6. Build vertical recommendation list and refresh button.
7. Run controller tests, typecheck, and build.

### Task 4: Verification

**Files:**
- No new files expected.

**Steps:**
1. Run targeted API tests.
2. Run targeted controller tests.
3. Run `pnpm -F @home-ktv/api typecheck`.
4. Run `pnpm -F @home-ktv/controller typecheck`.
5. Run `pnpm -F @home-ktv/controller build`.
