import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { LyricsOverlay } from "../components/LyricsOverlay.js";
import type { KaraokeLine } from "../runtime/karaoke.js";
import { tvTheme } from "../theme.js";

// 对齐产物:英文词不带空格(words[].text 为 aligner 返回的原样),
// 空格由渲染层负责补回
const englishLines: readonly KaraokeLine[] = [
  {
    startMs: 10_000,
    endMs: 14_000,
    text: "When you think of me",
    words: [
      { text: "When", startMs: 10_000, endMs: 11_000 },
      { text: "you", startMs: 11_000, endMs: 12_000 },
      { text: "think", startMs: 12_000, endMs: 13_000 },
      { text: "of", startMs: 13_000, endMs: 13_500 },
      { text: "me", startMs: 13_500, endMs: 14_000 }
    ]
  }
];

const chineseLines: readonly KaraokeLine[] = [
  {
    startMs: 10_000,
    endMs: 13_000,
    text: "我曾经",
    words: [
      { text: "我", startMs: 10_000, endMs: 11_000 },
      { text: "曾", startMs: 11_000, endMs: 12_000 },
      { text: "经", startMs: 12_000, endMs: 13_000 }
    ]
  }
];

const fallbackLines: readonly KaraokeLine[] = [
  { startMs: 10_000, endMs: 14_000, text: "When you think of me", words: [] }
];

function currentLine(container: HTMLElement): HTMLElement {
  // overlay 结构:previous / current / next 三个行 span,当前行是第二个
  const overlay = container.querySelector('div[aria-label="同步歌词"]');
  const line = overlay?.children[1];
  if (!(line instanceof HTMLElement)) {
    throw new Error("current lyric line not found");
  }
  return line;
}

function wordSpans(container: HTMLElement): HTMLElement[] {
  return Array.from(currentLine(container).querySelectorAll("span"));
}

describe("LyricsOverlay karaoke rendering", () => {
  it("separates English words with spaces instead of gluing them", () => {
    const { container } = render(
      <LyricsOverlay karaokeLines={englishLines} lrcLines={[]} positionMs={12_500} />
    );

    expect(container.textContent).toContain("When you think of me");
    expect(container.textContent).not.toContain("Whenyou");
  });

  it("does not insert spaces between CJK characters", () => {
    const { container } = render(
      <LyricsOverlay karaokeLines={chineseLines} lrcLines={[]} positionMs={12_500} />
    );

    expect(currentLine(container).textContent).toBe("我曾经");
  });

  it("falls back to whole-line text with spaces for lines without word timing", () => {
    const { container } = render(
      <LyricsOverlay karaokeLines={fallbackLines} lrcLines={[]} positionMs={12_500} />
    );

    expect(currentLine(container).textContent).toContain("When you think of me");
  });

  it("sweeps the active word with an intra-word gradient at its progress", () => {
    // 12_500 落在 "think"(12_000..13_000)正中间 => 词内进度 0.5
    const { container } = render(
      <LyricsOverlay karaokeLines={englishLines} lrcLines={[]} positionMs={12_500} />
    );

    const spans = wordSpans(container);
    expect(spans.map((span) => span.textContent)).toEqual(["When", "you", "think", "of", "me"]);

    const active = spans[2];
    expect(active?.style.backgroundClip).toBe("text");
    expect(active?.style.color).toBe("transparent");
    expect(active?.style.backgroundImage).toContain("linear-gradient");
    expect(active?.style.backgroundImage).toContain(tvTheme.colors.accent);
    expect(active?.style.backgroundImage).toContain(tvTheme.colors.textMuted);
    expect(active?.style.backgroundImage).toContain("50%");

    // 已唱词纯 accent、未唱词纯 muted,不用渐变
    expect(spans[0]?.style.color).toBe(tvTheme.colors.accent);
    expect(spans[1]?.style.color).toBe(tvTheme.colors.accent);
    expect(spans[0]?.style.backgroundImage).toBe("");
    expect(spans[3]?.style.color).toBe(tvTheme.colors.textMuted);
    expect(spans[4]?.style.color).toBe(tvTheme.colors.textMuted);
    expect(spans[3]?.style.backgroundImage).toBe("");
  });

  it("keeps the sung gradient boundary consistent when the word has just started or finished", () => {
    const start = render(
      <LyricsOverlay karaokeLines={englishLines} lrcLines={[]} positionMs={12_000} />
    );
    const activeAtStart = wordSpans(start.container)[2];
    // progress=0:渐变 0% 处仍是纯 muted,与未唱词颜色衔接
    expect(activeAtStart?.style.backgroundImage).toContain(" 0%,");
    expect(activeAtStart?.style.backgroundImage).toContain("0%");

    const end = render(
      <LyricsOverlay karaokeLines={englishLines} lrcLines={[]} positionMs={13_999} />
    );
    const sungAtEnd = wordSpans(end.container)[2];
    expect(sungAtEnd?.style.color).toBe(tvTheme.colors.accent);
  });
});
