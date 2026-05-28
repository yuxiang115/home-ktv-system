import type { RoomInteractionEvent } from "@home-ktv/player-contracts";

export interface InteractionViewport {
  height: number;
  width: number;
}

export type InteractionVisualVariant = "emoji-orb" | "bullet-banner" | "blessing-card";
export type InteractionBodyShape = "circle" | "rectangle";

export interface InteractionSpawnPlan {
  angularVelocity: number;
  density: number;
  friction: number;
  frictionAir: number;
  height: number;
  initialAngle: number;
  restitution: number;
  shape: InteractionBodyShape;
  variant: InteractionVisualVariant;
  velocityX: number;
  velocityY: number;
  width: number;
  x: number;
  y: number;
}

export interface EmojiConfettiParticle {
  color: string;
  delayMs: number;
  durationMs: number;
  height: number;
  initialAngle: number;
  rotation: number;
  travelX: number;
  travelY: number;
  width: number;
  x: number;
  y: number;
}

const confettiColors = ["#facc15", "#22d3ee", "#fb7185", "#a78bfa", "#34d399", "#f97316", "#f472b6", "#f8fafc"];

export function createInteractionSpawnPlan(
  interaction: RoomInteractionEvent,
  viewport: InteractionViewport,
  random: () => number = Math.random
): InteractionSpawnPlan {
  const width = Math.max(320, viewport.width);
  const height = Math.max(240, viewport.height);
  const x = lerp(width * 0.12, width * 0.88, random());
  const y = lerp(height * 0.88, height * 0.98, random());

  if (interaction.kind === "emoji") {
    const size = lerp(clamp(width * 0.048, 72, 116), clamp(width * 0.068, 96, 148), random());
    const launchAngle = lerp(-Math.PI * 0.86, -Math.PI * 0.14, random());
    const speed = lerp(18, 31, random());
    return {
      angularVelocity: signed(random(), 0.18, 0.46),
      density: 0.0012,
      friction: 0.012,
      frictionAir: 0.0024,
      height: size,
      initialAngle: signed(random(), 0.05, 0.32),
      restitution: 0.985,
      shape: "circle",
      variant: "emoji-orb",
      velocityX: Math.cos(launchAngle) * speed,
      velocityY: Math.sin(launchAngle) * speed,
      width: size,
      x,
      y
    };
  }

  if (interaction.kind === "bullet") {
    const bodyWidth = lerp(clamp(width * 0.19, 260, 420), clamp(width * 0.27, 340, 560), random());
    const bodyHeight = lerp(clamp(height * 0.05, 58, 86), clamp(height * 0.076, 74, 112), random());
    const horizontalDirection = random() < 0.5 ? -1 : 1;
    return {
      angularVelocity: signed(random(), 0.025, 0.085),
      density: 0.0014,
      friction: 0.04,
      frictionAir: 0.006,
      height: bodyHeight,
      initialAngle: signed(random(), 0.015, 0.09),
      restitution: 0.93,
      shape: "rectangle",
      variant: "bullet-banner",
      velocityX: horizontalDirection * lerp(10, 16, random()),
      velocityY: -lerp(3, 7, random()),
      width: bodyWidth,
      x,
      y
    };
  }

  const bodyWidth = lerp(clamp(width * 0.3, 420, 640), clamp(width * 0.38, 520, 760), random());
  const bodyHeight = lerp(clamp(height * 0.085, 92, 130), clamp(height * 0.125, 122, 172), random());
  const launchAngle = lerp(-Math.PI * 0.72, -Math.PI * 0.28, random());
  const speed = lerp(6, 11, random());
  return {
    angularVelocity: signed(random(), 0.018, 0.055),
    density: 0.0018,
    friction: 0.08,
    frictionAir: 0.014,
    height: bodyHeight,
    initialAngle: signed(random(), 0.02, 0.08),
    restitution: 0.78,
    shape: "rectangle",
    variant: "blessing-card",
    velocityX: Math.cos(launchAngle) * speed,
    velocityY: Math.sin(launchAngle) * speed,
    width: bodyWidth,
    x,
    y
  };
}

export function createEmojiConfettiBurst(
  plan: InteractionSpawnPlan,
  random: () => number = Math.random
): EmojiConfettiParticle[] {
  if (plan.variant !== "emoji-orb") {
    return [];
  }

  const launchAngle = Math.atan2(plan.velocityY, plan.velocityX);
  return Array.from({ length: 12 }, (_, index) => {
    const angle = launchAngle + signed(random(), 0.12, 0.72);
    const distance = lerp(170, 520, random());
    const travelY = Math.min(-110, Math.sin(angle) * distance - lerp(40, 130, random()));
    return {
      color: confettiColors[index % confettiColors.length] ?? "#facc15",
      delayMs: Math.round(index * 18 + lerp(0, 62, random())),
      durationMs: Math.round(lerp(880, 1480, random())),
      height: lerp(26, 68, random()),
      initialAngle: signed(random(), 0.08, 0.46),
      rotation: signed(random(), Math.PI * 0.75, Math.PI * 2.6),
      travelX: Math.cos(angle) * distance + plan.velocityX * lerp(8, 14, random()),
      travelY,
      width: lerp(7, 16, random()),
      x: plan.x,
      y: plan.y
    };
  });
}

function lerp(from: number, to: number, progress: number): number {
  return from + (to - from) * clamp(progress, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function signed(randomValue: number, min: number, max: number): number {
  const direction = randomValue < 0.5 ? -1 : 1;
  const progress = randomValue < 0.5 ? randomValue * 2 : (randomValue - 0.5) * 2;
  return direction * lerp(min, max, progress);
}
