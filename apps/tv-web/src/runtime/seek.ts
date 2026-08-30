// YouTube 风格左右快进/快退:每次按键累积一个步长,停顿后一次性提交到视频。
// 步长/节奏常量与纯逻辑都在这里,方便单测。
export const SEEK_STEP_MS = 10_000;
export const SEEK_COMMIT_DELAY_MS = 700;
export const SEEK_FEEDBACK_TTL_MS = 900;
export const SEEK_DOUBLE_TAP_MS = 350;
export const SEEK_MAX_CHEVRONS = 5;
// 提交位置离总时长留一点余量,避免 seek 到末尾直接触发 ended
const SEEK_END_MARGIN_MS = 250;

export type SeekDirection = "backward" | "forward";

export interface SeekBurst {
  direction: SeekDirection;
  presses: number;
  /** 本轮累计位移(有符号) */
  totalMs: number;
  /** 本轮起始的歌内位置 */
  fromMs: number;
}

export interface SeekFeedback extends SeekBurst {
  /** 目标位置(已经边界收敛);提交后为实际生效位置 */
  toMs: number;
}

export interface SeekBounds {
  /** 当前流可达的最小歌内位置(remux 兜底流为切换点基准,完整流为 0) */
  streamStartMs: number;
  /** 歌曲总时长(毫秒);未知为 null(不设上限) */
  durationMs: number | null;
}

export function seekDirectionForDelta(deltaMs: number): SeekDirection | null {
  if (deltaMs > 0) {
    return "forward";
  }
  if (deltaMs < 0) {
    return "backward";
  }
  return null;
}

/**
 * 累积一次按键。同方向继续累积;方向翻转(或首次)从当前位置重新起算。
 * positionMs 为按下时刻的歌内真实进度(activePlaybackPositionMs)。
 */
export function advanceSeekBurst(current: SeekBurst | null, deltaMs: number, positionMs: number): SeekBurst {
  const direction = seekDirectionForDelta(deltaMs);
  if (!direction) {
    return current ?? { direction: "forward", presses: 0, totalMs: 0, fromMs: Math.max(0, Math.trunc(positionMs)) };
  }
  const base =
    current && current.direction === direction
      ? current
      : { direction, presses: 0, totalMs: 0, fromMs: Math.max(0, Math.trunc(positionMs)) };
  return {
    direction,
    presses: base.presses + 1,
    totalMs: base.totalMs + deltaMs,
    fromMs: base.fromMs
  };
}

/** 把"起始位置+累计位移"按当前流的边界收敛成可提交的目标位置 */
export function resolveSeekTargetMs(positionMs: number, bounds: SeekBounds): number {
  const upper =
    bounds.durationMs != null && bounds.durationMs > 0
      ? Math.max(bounds.streamStartMs, bounds.durationMs - SEEK_END_MARGIN_MS)
      : Number.POSITIVE_INFINITY;
  return Math.trunc(Math.min(Math.max(positionMs, bounds.streamStartMs), upper));
}

/** 03:05 式时钟文案 */
export function formatSeekClock(positionMs: number): string {
  const totalSeconds = Math.max(0, Math.trunc(positionMs / 1000));
  const minutes = Math.trunc(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${`${seconds}`.padStart(2, "0")}`;
}
