import type { RoomInteractionEvent } from "@home-ktv/player-contracts";
import Matter from "matter-js";
import type { CSSProperties } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { tvTheme } from "../theme.js";
import {
  createEmojiConfettiBurst,
  createInteractionSpawnPlan,
  type EmojiConfettiParticle,
  type InteractionSpawnPlan,
  type InteractionViewport,
  type InteractionVisualVariant
} from "./interaction-physics.js";

export interface InteractionOverlayProps {
  interactions: readonly RoomInteractionEvent[];
}

interface PhysicsRecord {
  body: Matter.Body;
  createdAtMs: number;
  confetti: readonly EmojiConfettiParticle[];
  expiresAtMs: number;
  interaction: RoomInteractionEvent;
  plan: InteractionSpawnPlan;
}

interface RenderedInteraction {
  angle: number;
  height: number;
  id: string;
  kind: RoomInteractionEvent["kind"];
  message: string;
  opacity: number;
  variant: InteractionVisualVariant;
  width: number;
  x: number;
  y: number;
}

interface RenderedConfetti extends EmojiConfettiParticle {
  id: string;
}

interface InteractionRenderState {
  bodies: RenderedInteraction[];
  confetti: RenderedConfetti[];
}

export function InteractionOverlay({ interactions }: InteractionOverlayProps) {
  const visibleInteractions = interactions ?? [];
  const prefersReducedMotion = usePrefersReducedMotion();

  if (visibleInteractions.length === 0) {
    return null;
  }

  if (prefersReducedMotion) {
    return <StaticInteractionOverlay interactions={visibleInteractions} />;
  }

  return <AnimatedInteractionOverlay interactions={visibleInteractions} />;
}

function AnimatedInteractionOverlay({ interactions }: { interactions: readonly RoomInteractionEvent[] }) {
  const emojiItems = useMemo(
    () => interactions.filter((interaction) => interaction.kind === "emoji"),
    [interactions]
  );
  const bulletItems = useMemo(
    () => interactions.filter((interaction) => interaction.kind === "bullet"),
    [interactions]
  );
  const blessingItems = useMemo(
    () => sortNewestFirst(interactions.filter((interaction) => interaction.kind === "blessing")),
    [interactions]
  );
  const renderState = useInteractionPhysics(emojiItems);

  return (
    <div aria-live="polite" style={styles.root}>
      <style>{`${confettiKeyframes}\n${textOverlayKeyframes}`}</style>
      {renderState.confetti.map((particle) => (
        <ConfettiParticle key={particle.id} particle={particle} />
      ))}
      {renderState.bodies.map((item) => (
        <InteractionBody key={item.id} item={item} />
      ))}
      {bulletItems.map((interaction) => (
        <BulletMarquee interaction={interaction} key={interaction.id} />
      ))}
      {blessingItems.length > 0 ? (
        <div style={styles.blessingStack}>
          {blessingItems.map((interaction) => (
            <BlessingStackItem interaction={interaction} key={interaction.id} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ConfettiParticle({ particle }: { particle: RenderedConfetti }) {
  const style = {
    ...styles.confettiParticle,
    "--ktv-confetti-angle": `${particle.initialAngle}rad`,
    "--ktv-confetti-rotate": `${particle.rotation}rad`,
    "--ktv-confetti-x": `${particle.travelX}px`,
    "--ktv-confetti-y": `${particle.travelY}px`,
    animationDelay: `${particle.delayMs}ms`,
    animationDuration: `${particle.durationMs}ms`,
    background: particle.color,
    height: particle.height,
    left: particle.x,
    width: particle.width,
    top: particle.y
  } as CSSProperties;

  return <span aria-hidden="true" data-testid="emoji-confetti" style={style} />;
}

function InteractionBody({ item }: { item: RenderedInteraction }) {
  const transform = `translate3d(${item.x - item.width / 2}px, ${item.y - item.height / 2}px, 0) rotate(${item.angle}rad)`;
  const baseStyle: CSSProperties = {
    ...styles.physicsItem,
    height: item.height,
    opacity: item.opacity,
    transform,
    width: item.width
  };

  if (item.variant === "emoji-orb") {
    return (
      <div role="status" style={{ ...baseStyle, ...styles.emojiOrb }}>
        <span style={{ ...styles.emojiGlyph, fontSize: Math.max(48, item.width * 0.56) }}>{item.message}</span>
      </div>
    );
  }

  if (item.variant === "bullet-banner") {
    const accentStyle = bulletAccentStyle(item.id);
    return (
      <div role="status" style={{ ...baseStyle, ...styles.bulletBanner, ...accentStyle }}>
        <span style={styles.bulletAccent} />
        <strong style={styles.bulletText}>{item.message}</strong>
      </div>
    );
  }

  return (
    <div role="status" style={{ ...baseStyle, ...styles.blessingCard }}>
      <span style={styles.blessingLabel}>祝福</span>
      <strong style={styles.blessingText}>{item.message}</strong>
    </div>
  );
}

function BulletMarquee({ interaction }: { interaction: RoomInteractionEvent }) {
  const style = {
    ...styles.bulletMarquee,
    ...bulletAccentStyle(interaction.id),
    "--ktv-bullet-y": `${bulletVerticalPosition(interaction.id)}vh`
  } as CSSProperties;

  return (
    <div data-testid="bullet-marquee" role="status" style={style}>
      <span style={styles.bulletMarqueeGlow} aria-hidden="true" />
      <strong style={styles.bulletMarqueeText}>{interaction.message}</strong>
    </div>
  );
}

function BlessingStackItem({ interaction }: { interaction: RoomInteractionEvent }) {
  return (
    <div data-testid="blessing-stack-item" role="status" style={styles.blessingStackItem}>
      <span style={styles.blessingStackLabel}>祝福</span>
      <strong style={styles.blessingStackText}>{interaction.message}</strong>
    </div>
  );
}

function StaticInteractionOverlay({ interactions }: { interactions: readonly RoomInteractionEvent[] }) {
  const emojiItems = interactions.filter((interaction) => interaction.kind === "emoji");
  const bulletItems = interactions.filter((interaction) => interaction.kind === "bullet");
  const blessingItems = sortNewestFirst(interactions.filter((interaction) => interaction.kind === "blessing"));

  return (
    <div aria-live="polite" style={styles.root}>
      <div style={styles.staticBulletLane}>
        {bulletItems.map((interaction) => (
          <div key={interaction.id} role="status" style={styles.staticBullet}>
            {interaction.message}
          </div>
        ))}
      </div>
      <div style={styles.staticEmojiLane}>
        {emojiItems.map((interaction) => (
          <div key={interaction.id} role="status" style={styles.staticEmoji}>
            {interaction.message}
          </div>
        ))}
      </div>
      <div style={styles.staticBlessingLane}>
        {blessingItems.slice(0, 2).map((interaction) => (
          <div key={interaction.id} role="status" style={styles.staticBlessing}>
            <span style={styles.blessingLabel}>祝福</span>
            <strong style={styles.blessingText}>{interaction.message}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function sortNewestFirst(interactions: readonly RoomInteractionEvent[]): RoomInteractionEvent[] {
  return interactions
    .map((interaction, index) => ({ index, interaction }))
    .sort((left, right) => {
      const timeDiff = interactionTime(right.interaction) - interactionTime(left.interaction);
      return timeDiff === 0 ? right.index - left.index : timeDiff;
    })
    .map(({ interaction }) => interaction);
}

function interactionTime(interaction: RoomInteractionEvent): number {
  const time = Date.parse(interaction.createdAt);
  return Number.isFinite(time) ? time : 0;
}

function bulletVerticalPosition(id: string): number {
  const hash = stableHash(id);
  const lane = hash % 14;
  const laneOffset = (Math.floor(hash / 14) % 4) * 0.8;
  return 11 + lane * 4.6 + laneOffset;
}

interface BulletAccentTone {
  end: string;
  start: string;
}

const defaultBulletAccentTone: BulletAccentTone = { start: "#22D3EE", end: "#34D399" };

const bulletAccentPalette: readonly BulletAccentTone[] = [
  defaultBulletAccentTone,
  { start: "#34D399", end: "#A7F3D0" },
  { start: "#FACC15", end: "#FB923C" },
  { start: "#F472B6", end: "#A78BFA" },
  { start: "#A78BFA", end: "#60A5FA" },
  { start: "#FB923C", end: "#F97316" },
  { start: "#60A5FA", end: "#22D3EE" },
  { start: "#F8FAFC", end: "#CBD5E1" }
];

function bulletAccentStyle(id: string): CSSProperties {
  const tone = bulletAccentPalette[stableHash(id) % bulletAccentPalette.length] ?? defaultBulletAccentTone;
  return {
    "--ktv-bullet-accent": tone.start,
    "--ktv-bullet-accent-border": hexToRgba(tone.start, 0.54),
    "--ktv-bullet-accent-end": tone.end,
    "--ktv-bullet-accent-glow": hexToRgba(tone.start, 0.58),
    "--ktv-bullet-accent-halo": hexToRgba(tone.start, 0.2)
  } as CSSProperties;
}

function hexToRgba(hex: string, alpha: number): string {
  const normalized = hex.replace("#", "");
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  return `rgba(${red},${green},${blue},${alpha})`;
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function useInteractionPhysics(interactions: readonly RoomInteractionEvent[]): InteractionRenderState {
  const engineRef = useRef<Matter.Engine | null>(null);
  const recordsRef = useRef(new Map<string, PhysicsRecord>());
  const wallsRef = useRef<Matter.Body[]>([]);
  const [renderState, setRenderState] = useState<InteractionRenderState>({ bodies: [], confetti: [] });
  const isTestEnvironment = isVitestRuntime();

  useEffect(() => {
    const engine = Matter.Engine.create({ enableSleeping: false });
    engine.gravity.y = 1;
    engine.gravity.scale = 0.0011;
    engine.positionIterations = 8;
    engine.velocityIterations = 6;
    engineRef.current = engine;

    const installWalls = () => {
      const viewport = readViewport();
      removeWalls(engine, wallsRef.current);
      wallsRef.current = createWalls(viewport);
      Matter.Composite.add(engine.world, wallsRef.current);
    };

    installWalls();
    window.addEventListener("resize", installWalls);

    const initialTime = performance.now();
    setRenderState(renderRecords(recordsRef.current, initialTime));

    if (!isTestEnvironment) {
      let animationFrameId = 0;
      let previousTime = initialTime;
      const tick = (time: number) => {
        const deltaMs = Math.min(32, Math.max(12, time - previousTime || 16.67));
        previousTime = time;
        Matter.Engine.update(engine, deltaMs);
        setRenderState(renderRecords(recordsRef.current, time));
        animationFrameId = window.requestAnimationFrame(tick);
      };
      animationFrameId = window.requestAnimationFrame(tick);

      return () => {
        window.cancelAnimationFrame(animationFrameId);
        window.removeEventListener("resize", installWalls);
        for (const record of recordsRef.current.values()) {
          Matter.Composite.remove(engine.world, record.body);
        }
        removeWalls(engine, wallsRef.current);
        recordsRef.current.clear();
        wallsRef.current = [];
        engineRef.current = null;
      };
    }

    return () => {
      window.removeEventListener("resize", installWalls);
      for (const record of recordsRef.current.values()) {
        Matter.Composite.remove(engine.world, record.body);
      }
      removeWalls(engine, wallsRef.current);
      recordsRef.current.clear();
      wallsRef.current = [];
      engineRef.current = null;
    };
  }, [isTestEnvironment]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) {
      return;
    }

    const nextIds = new Set(interactions.map((interaction) => interaction.id));
    for (const id of recordsRef.current.keys()) {
      if (!nextIds.has(id)) {
        removeRecord(engine, recordsRef.current, id);
      }
    }

    const viewport = readViewport();
    for (const interaction of interactions) {
      if (recordsRef.current.has(interaction.id)) {
        continue;
      }

      const plan = createInteractionSpawnPlan(interaction, viewport, Math.random);
      const body = createBody(plan, interaction.id);
      Matter.Body.setVelocity(body, { x: plan.velocityX, y: plan.velocityY });
      Matter.Body.setAngle(body, plan.initialAngle);
      Matter.Body.setAngularVelocity(body, plan.angularVelocity);
      Matter.Composite.add(engine.world, body);
      recordsRef.current.set(interaction.id, {
        body,
        createdAtMs: Date.now(),
        confetti: createEmojiConfettiBurst(plan, Math.random),
        expiresAtMs: new Date(interaction.expiresAt).getTime(),
        interaction,
        plan
      });
    }

    setRenderState(renderRecords(recordsRef.current, performance.now()));
  }, [interactions]);

  return renderState;
}

function isVitestRuntime(): boolean {
  const meta = import.meta as ImportMeta & { env?: { MODE?: string }; vitest?: boolean };
  return Boolean(meta.vitest || meta.env?.MODE === "test");
}

function createBody(plan: InteractionSpawnPlan, id: string): Matter.Body {
  const options: Matter.IChamferableBodyDefinition = {
    density: plan.density,
    friction: plan.friction,
    frictionAir: plan.frictionAir,
    label: id,
    restitution: plan.restitution
  };

  if (plan.shape === "circle") {
    return Matter.Bodies.circle(plan.x, plan.y, plan.width / 2, options);
  }

  return Matter.Bodies.rectangle(plan.x, plan.y, plan.width, plan.height, {
    ...options,
    chamfer: { radius: Math.min(plan.height / 2, 34) }
  });
}

function createWalls(viewport: InteractionViewport): Matter.Body[] {
  const thickness = 96;
  const options: Matter.IChamferableBodyDefinition = {
    friction: 0.02,
    isStatic: true,
    restitution: 0.985
  };

  return [
    Matter.Bodies.rectangle(viewport.width / 2, -thickness / 2, viewport.width + thickness * 2, thickness, options),
    Matter.Bodies.rectangle(viewport.width / 2, viewport.height + thickness / 2, viewport.width + thickness * 2, thickness, options),
    Matter.Bodies.rectangle(-thickness / 2, viewport.height / 2, thickness, viewport.height + thickness * 2, options),
    Matter.Bodies.rectangle(viewport.width + thickness / 2, viewport.height / 2, thickness, viewport.height + thickness * 2, options)
  ];
}

function removeWalls(engine: Matter.Engine, walls: readonly Matter.Body[]) {
  for (const wall of walls) {
    Matter.Composite.remove(engine.world, wall);
  }
}

function removeRecord(engine: Matter.Engine, records: Map<string, PhysicsRecord>, id: string) {
  const record = records.get(id);
  if (!record) {
    return;
  }

  Matter.Composite.remove(engine.world, record.body);
  records.delete(id);
}

function renderRecords(records: Map<string, PhysicsRecord>, now: number): InteractionRenderState {
  const realNow = Date.now();
  const bodies: RenderedInteraction[] = [];
  const confetti: RenderedConfetti[] = [];
  for (const [id, record] of records) {
    if (record.expiresAtMs <= realNow) {
      bodies.push(renderRecord(id, record, 0));
      continue;
    }

    const ttlMs = Math.max(1, record.expiresAtMs - record.createdAtMs);
    const elapsedMs = Math.max(0, realNow - record.createdAtMs);
    const fadeProgress = Math.max(0, (elapsedMs - ttlMs * 0.72) / (ttlMs * 0.28));
    const breathing = record.interaction.kind === "emoji" ? 0.04 * Math.sin(now / 120) : 0;
    bodies.push(renderRecord(id, record, Math.max(0.16, 1 - fadeProgress + breathing)));
    confetti.push(...renderConfetti(id, record, elapsedMs));
  }
  return { bodies, confetti };
}

function renderRecord(id: string, record: PhysicsRecord, opacity: number): RenderedInteraction {
  return {
    angle: record.body.angle,
    height: record.plan.height,
    id,
    kind: record.interaction.kind,
    message: record.interaction.message,
    opacity,
    variant: record.plan.variant,
    width: record.plan.width,
    x: record.body.position.x,
    y: record.body.position.y
  };
}

function renderConfetti(id: string, record: PhysicsRecord, elapsedMs: number): RenderedConfetti[] {
  return record.confetti
    .map((particle, index) => ({ ...particle, id: `${id}-confetti-${index}` }))
    .filter((particle) => elapsedMs <= particle.delayMs + particle.durationMs + 180);
}

function readViewport(): InteractionViewport {
  return {
    height: Math.max(240, window.innerHeight || 1080),
    width: Math.max(320, window.innerWidth || 1920)
  };
}

function usePrefersReducedMotion(): boolean {
  const query = useMemo(() => "(prefers-reduced-motion: reduce)", []);
  const [reducedMotion, setReducedMotion] = useState(() => Boolean(window.matchMedia?.(query).matches));

  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) {
      return;
    }

    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => {
      media.removeEventListener?.("change", update);
    };
  }, [query]);

  return reducedMotion;
}

const confettiKeyframes = `
@keyframes ktv-confetti-cannon {
  0% {
    opacity: 0;
    transform: translate3d(-50%, -50%, 0) rotate(var(--ktv-confetti-angle)) scale(0.28);
  }
  10% {
    opacity: 1;
    transform: translate3d(-50%, -50%, 0) rotate(var(--ktv-confetti-angle)) scale(1);
  }
  74% {
    opacity: 0.92;
  }
  100% {
    opacity: 0;
    transform: translate3d(calc(-50% + var(--ktv-confetti-x)), calc(-50% + var(--ktv-confetti-y)), 0)
      rotate(var(--ktv-confetti-rotate)) scale(0.86);
  }
}
`;

const textOverlayKeyframes = `
@keyframes ktv-bullet-marquee {
  0% {
    opacity: 0;
    transform: translate3d(110vw, var(--ktv-bullet-y), 0) scale(0.98);
  }
  7% {
    opacity: 1;
  }
  86% {
    opacity: 1;
  }
  100% {
    opacity: 0;
    transform: translate3d(-120%, var(--ktv-bullet-y), 0) scale(1);
  }
}

@keyframes ktv-blessing-float {
  0% {
    opacity: 0;
    transform: translate3d(0, -38px, 0) scale(0.96);
  }
  9% {
    opacity: 1;
    transform: translate3d(0, 0, 0) scale(1);
  }
  86% {
    opacity: 1;
    transform: translate3d(0, 0, 0) scale(1);
  }
  100% {
    opacity: 0;
    transform: translate3d(0, 0, 0) scale(0.99);
  }
}
`;

const styles = {
  root: {
    inset: 0,
    overflow: "hidden",
    pointerEvents: "none",
    position: "absolute",
    zIndex: 8
  },
  physicsItem: {
    alignItems: "center",
    boxSizing: "border-box",
    display: "flex",
    justifyContent: "center",
    left: 0,
    lineHeight: 1,
    position: "absolute",
    top: 0,
    transformOrigin: "50% 50%",
    userSelect: "none",
    willChange: "transform, opacity"
  },
  confettiParticle: {
    animationFillMode: "forwards",
    animationName: "ktv-confetti-cannon",
    animationTimingFunction: "cubic-bezier(0.17, 0.67, 0.2, 1)",
    borderRadius: 3,
    boxShadow: "0 0 14px rgba(255,255,255,0.32)",
    opacity: 0,
    position: "absolute",
    transformOrigin: "50% 50%",
    willChange: "transform, opacity"
  },
  emojiOrb: {
    backdropFilter: "blur(18px)",
    background:
      "linear-gradient(145deg, rgba(255,255,255,0.36), rgba(251,191,36,0.13) 54%, rgba(14,165,233,0.16)), rgba(2,6,23,0.42)",
    border: "1px solid rgba(253, 224, 71, 0.6)",
    borderRadius: "999px",
    boxShadow: "0 30px 90px rgba(0,0,0,0.38), inset 0 1px 0 rgba(255,255,255,0.26)",
    filter: "drop-shadow(0 16px 22px rgba(0,0,0,0.35))"
  },
  emojiGlyph: {
    filter: "drop-shadow(0 8px 12px rgba(0,0,0,0.34))"
  },
  bulletBanner: {
    backdropFilter: "blur(20px)",
    background: "linear-gradient(135deg, rgba(8,47,73,0.78), rgba(15,23,42,0.7))",
    border: "1px solid var(--ktv-bullet-accent-border, rgba(34,211,238,0.55))",
    borderRadius: tvTheme.radii.pill,
    boxShadow: "0 30px 94px rgba(0,0,0,0.45), 0 0 36px var(--ktv-bullet-accent-halo, rgba(34,211,238,0.2))",
    color: tvTheme.colors.text,
    gap: 16,
    padding: "0 30px"
  },
  bulletAccent: {
    background:
      "linear-gradient(180deg, var(--ktv-bullet-accent, #22d3ee), var(--ktv-bullet-accent-end, #22c55e))",
    borderRadius: 999,
    boxShadow: "0 0 22px var(--ktv-bullet-accent-glow, rgba(34,211,238,0.58))",
    flex: "0 0 auto",
    height: "52%",
    width: 8
  },
  bulletText: {
    fontSize: "clamp(24px, 2.6vw, 46px)",
    fontWeight: 950,
    lineHeight: 1.1,
    maxWidth: "100%",
    overflowWrap: "anywhere",
    textAlign: "center",
    textShadow: "0 6px 18px rgba(0,0,0,0.45)"
  },
  bulletMarquee: {
    alignItems: "center",
    animationDuration: "7000ms",
    animationFillMode: "forwards",
    animationName: "ktv-bullet-marquee",
    animationTimingFunction: "linear",
    backdropFilter: "blur(16px)",
    background: "linear-gradient(135deg, rgba(8,47,73,0.82), rgba(15,23,42,0.72))",
    border: "1px solid var(--ktv-bullet-accent-border, rgba(34,211,238,0.54))",
    borderRadius: tvTheme.radii.pill,
    boxShadow: "0 24px 72px rgba(0,0,0,0.42), 0 0 30px var(--ktv-bullet-accent-halo, rgba(34,211,238,0.18))",
    color: tvTheme.colors.text,
    display: "inline-flex",
    gap: 14,
    left: 0,
    lineHeight: 1,
    padding: "14px 28px 14px 22px",
    position: "absolute",
    top: 0,
    userSelect: "none",
    whiteSpace: "nowrap",
    width: "max-content",
    willChange: "transform, opacity"
  },
  bulletMarqueeGlow: {
    background:
      "linear-gradient(180deg, var(--ktv-bullet-accent, #22d3ee), var(--ktv-bullet-accent-end, #22c55e))",
    borderRadius: 999,
    boxShadow: "0 0 20px var(--ktv-bullet-accent-glow, rgba(34,211,238,0.58))",
    flex: "0 0 auto",
    height: 34,
    width: 7
  },
  bulletMarqueeText: {
    fontSize: "clamp(24px, 2.15vw, 40px)",
    fontWeight: 950,
    lineHeight: 1.08,
    textShadow: "0 6px 18px rgba(0,0,0,0.46)"
  },
  blessingCard: {
    alignContent: "center",
    backdropFilter: "blur(22px)",
    background:
      "linear-gradient(135deg, rgba(244,114,182,0.34), rgba(34,211,238,0.24)), linear-gradient(180deg, rgba(15,23,42,0.92), rgba(2,6,23,0.8))",
    border: "1px solid rgba(244,114,182,0.62)",
    borderRadius: 24,
    boxShadow: "0 34px 110px rgba(0,0,0,0.5), 0 0 42px rgba(244,114,182,0.18)",
    color: tvTheme.colors.text,
    display: "grid",
    gap: 10,
    justifyItems: "center",
    padding: "18px 42px",
    textAlign: "center"
  },
  blessingLabel: {
    color: tvTheme.colors.warning,
    fontSize: "clamp(18px, 1.6vw, 28px)",
    fontWeight: 950,
    letterSpacing: 0
  },
  blessingText: {
    color: tvTheme.colors.text,
    fontSize: "clamp(30px, 3.5vw, 60px)",
    fontWeight: 950,
    lineHeight: 1.08,
    overflowWrap: "anywhere",
    textShadow: "0 8px 24px rgba(0,0,0,0.42)"
  },
  blessingStack: {
    display: "grid",
    gap: 8,
    justifyItems: "center",
    left: "50%",
    maxWidth: "min(780px, 74vw)",
    position: "absolute",
    top: "4.8vh",
    transform: "translateX(-50%)",
    width: "100%"
  },
  blessingStackItem: {
    animationDuration: "7000ms",
    animationFillMode: "forwards",
    animationName: "ktv-blessing-float",
    animationTimingFunction: "cubic-bezier(0.18, 0.8, 0.2, 1)",
    backdropFilter: "blur(22px)",
    background:
      "linear-gradient(135deg, rgba(244,114,182,0.32), rgba(34,211,238,0.2)), linear-gradient(180deg, rgba(15,23,42,0.9), rgba(2,6,23,0.78))",
    border: "1px solid rgba(244,114,182,0.54)",
    borderRadius: 18,
    boxShadow: "0 26px 78px rgba(0,0,0,0.44), 0 0 34px rgba(244,114,182,0.16)",
    color: tvTheme.colors.text,
    display: "grid",
    gap: 6,
    justifyItems: "center",
    lineHeight: 1,
    padding: "12px 28px 14px",
    textAlign: "center",
    transition: "transform 240ms ease, opacity 240ms ease",
    userSelect: "none",
    width: "100%",
    willChange: "transform, opacity"
  },
  blessingStackLabel: {
    color: tvTheme.colors.warning,
    fontSize: "clamp(14px, 1vw, 20px)",
    fontWeight: 950,
    letterSpacing: 0
  },
  blessingStackText: {
    color: tvTheme.colors.text,
    fontSize: "clamp(24px, 2.25vw, 44px)",
    fontWeight: 950,
    lineHeight: 1.08,
    overflowWrap: "anywhere",
    textShadow: "0 8px 22px rgba(0,0,0,0.42)"
  },
  staticBulletLane: {
    display: "grid",
    gap: 14,
    left: "8vw",
    position: "absolute",
    right: "8vw",
    top: "18vh"
  },
  staticBullet: {
    alignSelf: "start",
    backdropFilter: "blur(20px)",
    background: "linear-gradient(135deg, rgba(8,47,73,0.82), rgba(15,23,42,0.74))",
    border: "1px solid rgba(34, 211, 238, 0.46)",
    borderRadius: tvTheme.radii.pill,
    boxShadow: "0 24px 80px rgba(0, 0, 0, 0.38)",
    color: tvTheme.colors.text,
    fontSize: "clamp(26px, 3.4vw, 52px)",
    fontWeight: 950,
    justifySelf: "center",
    lineHeight: 1.1,
    maxWidth: "84vw",
    overflowWrap: "anywhere",
    padding: "16px 30px"
  },
  staticEmojiLane: {
    display: "grid",
    gap: 18,
    position: "absolute",
    right: "8vw",
    top: "30vh"
  },
  staticEmoji: {
    alignItems: "center",
    backdropFilter: "blur(18px)",
    background: "linear-gradient(145deg, rgba(255,255,255,0.34), rgba(251,191,36,0.14)), rgba(2,6,23,0.54)",
    border: "1px solid rgba(251, 191, 36, 0.5)",
    borderRadius: "50%",
    boxShadow: "0 24px 80px rgba(0, 0, 0, 0.36)",
    color: tvTheme.colors.warning,
    display: "grid",
    fontSize: "clamp(54px, 7vw, 110px)",
    height: "clamp(96px, 11vw, 164px)",
    justifyItems: "center",
    lineHeight: 1,
    width: "clamp(96px, 11vw, 164px)"
  },
  staticBlessingLane: {
    display: "grid",
    gap: 10,
    left: "50%",
    maxWidth: "min(760px, 76vw)",
    position: "absolute",
    top: "6vh",
    transform: "translateX(-50%)",
    width: "100%"
  },
  staticBlessing: {
    backdropFilter: "blur(22px)",
    background: "linear-gradient(135deg, rgba(244, 114, 182, 0.3), rgba(34, 211, 238, 0.22)), rgba(15, 23, 42, 0.84)",
    border: "1px solid rgba(244, 114, 182, 0.48)",
    borderRadius: 24,
    boxShadow: "0 28px 92px rgba(0, 0, 0, 0.46)",
    color: tvTheme.colors.text,
    display: "grid",
    gap: 10,
    justifyItems: "center",
    padding: "24px 34px",
    textAlign: "center"
  }
} satisfies Record<string, CSSProperties>;
