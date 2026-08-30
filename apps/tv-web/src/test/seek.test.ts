import { describe, expect, it } from "vitest";
import {
  advanceSeekBurst,
  formatSeekClock,
  resolveSeekTargetMs,
  seekDirectionForDelta
} from "../runtime/seek.js";

describe("advanceSeekBurst", () => {
  it("accumulates repeated presses in the same direction", () => {
    let burst = advanceSeekBurst(null, 10_000, 30_000);
    burst = advanceSeekBurst(burst, 10_000, 30_000);
    burst = advanceSeekBurst(burst, 10_000, 30_000);

    expect(burst).toEqual({ direction: "forward", presses: 3, totalMs: 30_000, fromMs: 30_000 });
  });

  it("starts a fresh burst from the current position when the direction flips", () => {
    let burst = advanceSeekBurst(null, 10_000, 30_000);
    burst = advanceSeekBurst(burst, 10_000, 32_000);
    burst = advanceSeekBurst(burst, -10_000, 32_000);

    expect(burst).toEqual({ direction: "backward", presses: 1, totalMs: -10_000, fromMs: 32_000 });
  });

  it("keeps the burst untouched for a zero delta", () => {
    const burst = advanceSeekBurst({ direction: "forward", presses: 2, totalMs: 20_000, fromMs: 5_000 }, 0, 9_000);

    expect(burst).toEqual({ direction: "forward", presses: 2, totalMs: 20_000, fromMs: 5_000 });
  });
});

describe("resolveSeekTargetMs", () => {
  const fullStream = { streamStartMs: 0, durationMs: 240_000 };

  it("passes through targets inside the stream", () => {
    expect(resolveSeekTargetMs(65_000, fullStream)).toBe(65_000);
  });

  it("clamps to 0 for full-file streams", () => {
    expect(resolveSeekTargetMs(-15_000, fullStream)).toBe(0);
  });

  it("clamps slightly before the end so a seek does not trigger ended", () => {
    expect(resolveSeekTargetMs(300_000, fullStream)).toBe(239_750);
  });

  it("cannot seek backwards past the remux fallback stream start", () => {
    const remuxStream = { streamStartMs: 90_000, durationMs: 240_000 };
    expect(resolveSeekTargetMs(40_000, remuxStream)).toBe(90_000);
    expect(resolveSeekTargetMs(150_000, remuxStream)).toBe(150_000);
  });

  it("does not clamp the upper bound when duration is unknown", () => {
    expect(resolveSeekTargetMs(1_000_000, { streamStartMs: 0, durationMs: null })).toBe(1_000_000);
  });
});

describe("formatSeekClock", () => {
  it("formats minutes and zero-padded seconds", () => {
    expect(formatSeekClock(0)).toBe("0:00");
    expect(formatSeekClock(65_000)).toBe("1:05");
    expect(formatSeekClock(600_000)).toBe("10:00");
  });
});

describe("seekDirectionForDelta", () => {
  it("maps delta sign to direction", () => {
    expect(seekDirectionForDelta(10_000)).toBe("forward");
    expect(seekDirectionForDelta(-10_000)).toBe("backward");
    expect(seekDirectionForDelta(0)).toBeNull();
  });
});
