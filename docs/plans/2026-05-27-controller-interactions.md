# Controller Interactions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the mobile controller shortcut actions send realtime TV interactions.

**Architecture:** Add shared interaction contracts, an authenticated API route, broadcaster support for a second realtime message type, controller composers, and a TV overlay consumer. Keep events ephemeral and avoid changing playback session persistence.

**Tech Stack:** TypeScript, Fastify, React, existing WebSocket realtime channel, Vitest.

---

### Task 1: Shared Realtime Contracts

**Files:**
- Modify: `packages/player-contracts/src/index.ts`
- Modify: `packages/protocol/src/index.ts`

**Steps:**
1. Add `RoomInteractionKind`, `RoomInteractionEvent`, and `RoomInteractionEnvelope` types.
2. Add `room.interaction.created` to protocol room event names.
3. Run `pnpm -F @home-ktv/player-contracts typecheck` and `pnpm -F @home-ktv/protocol typecheck`.

### Task 2: API Broadcast Route

**Files:**
- Create: `apps/api/src/routes/room-interactions.ts`
- Modify: `apps/api/src/modules/realtime/room-snapshot-broadcaster.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/src/test/room-interactions-routes.test.ts`

**Steps:**
1. Add broadcaster method for `RoomInteractionEvent`.
2. Add `POST /rooms/:roomSlug/interactions`.
3. Validate room, control session, `deviceId`, `kind`, and bounded message.
4. Broadcast `room.interaction.created`.
5. Return `{ status: "accepted", interaction }`.

### Task 3: Controller Runtime And UI

**Files:**
- Modify: `apps/controller/src/api/client.ts`
- Modify: `apps/controller/src/runtime/use-room-controller-runtime.ts`
- Modify: `apps/controller/src/App.tsx`
- Modify: `apps/controller/src/App.css`
- Modify: `apps/controller/src/i18n.tsx`
- Test: `apps/controller/src/test/controller.test.tsx`

**Steps:**
1. Add `sendRoomInteraction`.
2. Expose `sendInteraction` from runtime with pending state.
3. Add shortcut composer panels.
4. Wire emoji presets, bullet input, blessing templates, and submit behavior.
5. Add controller tests for payloads.

### Task 4: TV Web Overlay

**Files:**
- Modify: `apps/tv-web/src/runtime/use-room-snapshot.ts`
- Modify: `apps/tv-web/src/runtime/use-tv-playback-runtime.ts`
- Modify: `apps/tv-web/src/App.tsx`
- Create: `apps/tv-web/src/components/InteractionOverlay.tsx`
- Test: `apps/tv-web/src/test/use-room-snapshot.test.ts`
- Test: `apps/tv-web/src/test/interaction-overlay.test.tsx`

**Steps:**
1. Parse `room.interaction.created` realtime messages.
2. Keep a short-lived local queue.
3. Render TV overlays above playback and idle screens.
4. Add tests for message parsing and overlay rendering.

### Task 5: Verification

**Commands:**
- `pnpm -F @home-ktv/player-contracts typecheck`
- `pnpm -F @home-ktv/protocol typecheck`
- `pnpm -F @home-ktv/api test -- room-interactions-routes.test.ts`
- `pnpm -F @home-ktv/controller test -- controller.test.tsx`
- `pnpm -F @home-ktv/tv-web test -- use-room-snapshot.test.ts interaction-overlay.test.tsx`
- `pnpm -F @home-ktv/api build`
- `pnpm -F @home-ktv/controller build`
- `pnpm -F @home-ktv/tv-web build`
