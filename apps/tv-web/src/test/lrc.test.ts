import { describe, expect, it } from "vitest";
import { activeLyricIndex, lyricLineProgress, lyricLineSpan, parseLrc } from "../runtime/lrc.js";

describe("parseLrc", () => {
  it("parses standard timestamped lines in order", () => {
    const lines = parseLrc("[00:12.00]第一句\n[00:30.50]第二句\n");

    expect(lines).toEqual([
      { timeMs: 12_000, text: "第一句" },
      { timeMs: 30_500, text: "第二句" }
    ]);
  });

  it("expands multiple timestamps on one line", () => {
    const lines = parseLrc("[00:12.00][01:30.00]副歌\n");

    expect(lines).toEqual([
      { timeMs: 12_000, text: "副歌" },
      { timeMs: 90_000, text: "副歌" }
    ]);
  });

  it("sorts out-of-order lines by time", () => {
    const lines = parseLrc("[01:00.00]后\n[00:10.00]前\n");

    expect(lines.map((line) => line.text)).toEqual(["前", "后"]);
  });

  it("interprets colon-form milliseconds and different fraction widths", () => {
    const lines = parseLrc("[00:12:30]a\n[00:13.5]b\n[00:14.500]c\n");

    expect(lines.map((line) => line.timeMs)).toEqual([12_300, 13_500, 14_500]);
  });

  it("skips metadata lines, blank text lines, and malformed input", () => {
    const lines = parseLrc("[ti:标题]\n[ar:歌手]\n[00:12.00]\n不是歌词\n[]空戳\n[00:15.00]有效\n");

    expect(lines).toEqual([{ timeMs: 15_000, text: "有效" }]);
  });

  it("returns empty for empty content", () => {
    expect(parseLrc("")).toEqual([]);
    expect(parseLrc("纯文本没有时间戳")).toEqual([]);
  });
});

describe("activeLyricIndex", () => {
  const lines = parseLrc("[00:10.00]a\n[00:20.00]b\n[00:30.00]c\n");

  it("returns -1 before the first line starts", () => {
    expect(activeLyricIndex(lines, 9_999)).toBe(-1);
  });

  it("returns the line whose timestamp has been reached", () => {
    expect(activeLyricIndex(lines, 10_000)).toBe(0);
    expect(activeLyricIndex(lines, 19_999)).toBe(0);
    expect(activeLyricIndex(lines, 25_000)).toBe(1);
    expect(activeLyricIndex(lines, 999_999)).toBe(2);
  });

  it("handles an empty line list", () => {
    expect(activeLyricIndex([], 5_000)).toBe(-1);
  });
});

describe("lyricLineSpan", () => {
  const lines = parseLrc("[00:10.00]a\n[00:20.00]b\n[00:30.00]c\n");

  it("spans from the line timestamp to the next line timestamp", () => {
    expect(lyricLineSpan(lines, 0)).toEqual({ startMs: 10_000, endMs: 20_000 });
    expect(lyricLineSpan(lines, 1)).toEqual({ startMs: 20_000, endMs: 30_000 });
  });

  it("uses a default tail span for the last line", () => {
    expect(lyricLineSpan(lines, 2)).toEqual({ startMs: 30_000, endMs: 40_000 });
  });

  it("returns null for out-of-range indexes", () => {
    expect(lyricLineSpan(lines, -1)).toBeNull();
    expect(lyricLineSpan(lines, 3)).toBeNull();
    expect(lyricLineSpan([], 0)).toBeNull();
  });
});

describe("lyricLineProgress", () => {
  it("interpolates linearly inside the line span", () => {
    const span = { startMs: 10_000, endMs: 20_000 };
    expect(lyricLineProgress(span, 10_000)).toBe(0);
    expect(lyricLineProgress(span, 15_000)).toBe(0.5);
    expect(lyricLineProgress(span, 20_000)).toBe(1);
  });

  it("clamps outside the span (before start and during interludes)", () => {
    const span = { startMs: 10_000, endMs: 20_000 };
    expect(lyricLineProgress(span, 5_000)).toBe(0);
    expect(lyricLineProgress(span, 99_000)).toBe(1);
  });

  it("never divides by zero for zero-width spans", () => {
    expect(lyricLineProgress({ startMs: 10_000, endMs: 10_000 }, 10_000)).toBe(1);
  });
});
