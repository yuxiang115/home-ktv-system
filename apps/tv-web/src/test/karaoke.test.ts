import { describe, expect, it } from "vitest";
import { activeKaraokeLineIndex, parseKaraokeLyrics } from "../runtime/karaoke.js";

const SAMPLE = JSON.stringify({
  lines: [
    {
      start: 62.31,
      end: 66.82,
      text: "我曾经跨过山和大海",
      words: [
        { text: "我", start: 62.31, end: 62.58 },
        { text: "曾", start: 62.58, end: 62.81 },
        { text: "经", start: 62.81, end: 63.05 }
      ]
    },
    {
      start: 67.0,
      end: 70.2,
      text: "也穿过人山人海",
      words: [{ text: "也", start: 67.0, end: 67.3 }]
    }
  ]
});

describe("parseKaraokeLyrics", () => {
  it("parses lines and words converting seconds to milliseconds", () => {
    const lines = parseKaraokeLyrics(SAMPLE);

    expect(lines).not.toBeNull();
    expect(lines?.[0]).toMatchObject({ startMs: 62_310, endMs: 66_820, text: "我曾经跨过山和大海" });
    expect(lines?.[0]?.words[0]).toEqual({ text: "我", startMs: 62_310, endMs: 62_580 });
    expect(lines?.[1]?.words[0]?.startMs).toBe(67_000);
  });

  it("sorts lines by start time and drops invalid entries", () => {
    const messy = JSON.stringify({
      lines: [
        { start: 67, end: 70, text: "后", words: [] },
        { start: "bad", end: 70, text: "丢", words: [] },
        null,
        { start: 10, end: 12, text: "前", words: [] }
      ]
    });

    const lines = parseKaraokeLyrics(messy);
    expect(lines?.map((line) => line.text)).toEqual(["前", "后"]);
  });

  it("returns null for invalid json or empty line arrays", () => {
    expect(parseKaraokeLyrics("not json")).toBeNull();
    expect(parseKaraokeLyrics(JSON.stringify({ lines: [] }))).toBeNull();
    expect(parseKaraokeLyrics(JSON.stringify({ lines: [{ start: 1, end: "x", text: "a" }] }))).toBeNull();
  });
});

describe("activeKaraokeLineIndex", () => {
  const lines = parseKaraokeLyrics(SAMPLE) ?? [];

  it("returns -1 before the first line and the reached line afterwards", () => {
    expect(activeKaraokeLineIndex(lines, 62_000)).toBe(-1);
    expect(activeKaraokeLineIndex(lines, 62_310)).toBe(0);
    expect(activeKaraokeLineIndex(lines, 66_999)).toBe(0);
    expect(activeKaraokeLineIndex(lines, 67_000)).toBe(1);
    expect(activeKaraokeLineIndex(lines, 999_999)).toBe(1);
  });

  it("handles an empty list", () => {
    expect(activeKaraokeLineIndex([], 1_000)).toBe(-1);
  });
});
