import type { RoomInteractionEvent } from "@home-ktv/player-contracts";
import { describe, expect, it } from "vitest";
import { createEmojiConfettiBurst, createInteractionSpawnPlan } from "../components/interaction-physics.js";

describe("interaction physics", () => {
  it("fires emoji interactions upward from the bottom with high bounce", () => {
    const plan = createInteractionSpawnPlan(interaction("emoji", "👏"), viewport, sequenceRandom([0.25, 0.4, 0.75, 0.2, 0.85]));

    expect(plan.variant).toBe("emoji-orb");
    expect(plan.x).toBeGreaterThanOrEqual(viewport.width * 0.12);
    expect(plan.x).toBeLessThanOrEqual(viewport.width * 0.88);
    expect(plan.y).toBeGreaterThanOrEqual(viewport.height * 0.88);
    expect(plan.velocityY).toBeLessThan(-5);
    expect(Math.hypot(plan.velocityX, plan.velocityY)).toBeGreaterThan(18);
    expect(Math.abs(plan.angularVelocity)).toBeGreaterThan(0);
    expect(plan.frictionAir).toBeLessThanOrEqual(0.003);
    expect(plan.restitution).toBeGreaterThanOrEqual(0.98);
  });

  it("uses different physical profiles for bullet and blessing cards", () => {
    const bullet = createInteractionSpawnPlan(interaction("bullet", "唱得太好了"), viewport, sequenceRandom([0.1, 0.8, 0.3, 0.6, 0.2]));
    const blessing = createInteractionSpawnPlan(interaction("blessing", "祝大家今晚开心"), viewport, sequenceRandom([0.6, 0.2, 0.5, 0.4, 0.7]));

    expect(bullet.variant).toBe("bullet-banner");
    expect(bullet.width).toBeGreaterThan(bullet.height);
    expect(Math.abs(bullet.velocityX)).toBeGreaterThan(Math.abs(bullet.velocityY));

    expect(blessing.variant).toBe("blessing-card");
    expect(blessing.width).toBeGreaterThan(bullet.width);
    expect(blessing.velocityY).toBeLessThan(0);
    expect(blessing.restitution).toBeLessThan(bullet.restitution);
  });

  it("creates a cannon-like confetti burst for emoji launches only", () => {
    const plan = createInteractionSpawnPlan(interaction("emoji", "🚀"), viewport, sequenceRandom([0.4, 0.35, 0.7, 0.2, 0.9]));
    const burst = createEmojiConfettiBurst(plan, sequenceRandom([0.1, 0.8, 0.2, 0.7, 0.3, 0.9]));
    const bulletPlan = createInteractionSpawnPlan(interaction("bullet", "唱得太好了"), viewport, sequenceRandom([0.2, 0.5, 0.6, 0.3, 0.7]));

    expect(burst).toHaveLength(12);
    expect(burst.every((particle) => particle.x === plan.x && particle.y === plan.y)).toBe(true);
    expect(burst.some((particle) => particle.travelY < -100)).toBe(true);
    expect(new Set(burst.map((particle) => particle.color)).size).toBeGreaterThan(3);
    expect(createEmojiConfettiBurst(bulletPlan, sequenceRandom([0.5]))).toEqual([]);
  });
});

const viewport = { width: 1920, height: 1080 };

function sequenceRandom(values: number[]): () => number {
  let index = 0;
  return () => values[index++ % values.length] ?? 0.5;
}

function interaction(kind: RoomInteractionEvent["kind"], message: string): RoomInteractionEvent {
  return {
    id: `interaction-${kind}`,
    roomId: "living-room",
    roomSlug: "living-room",
    kind,
    message,
    senderDeviceId: "phone-a",
    senderName: "Controller A",
    createdAt: "2026-05-27T10:00:00.000Z",
    expiresAt: "2026-05-27T10:00:07.000Z"
  };
}
