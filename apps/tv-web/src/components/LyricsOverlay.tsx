import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import { activeKaraokeLineIndex, type KaraokeLine } from "../runtime/karaoke.js";
import { activeLyricIndex, lyricLineProgress, lyricLineSpan, type LrcLine } from "../runtime/lrc.js";
import { tvTheme } from "../theme.js";

export interface LyricsOverlayProps {
  karaokeLines: readonly KaraokeLine[] | null;
  lrcLines: readonly LrcLine[];
  positionMs: number;
}

// KTV 式同步歌词:有逐字时间轴时一个字一个字点亮(已唱亮色、未唱底色);
    // 只有行级 LRC 时退化为整行扫光(行内线性插值)。200ms 自刷新跟随进度。
export function LyricsOverlay({ karaokeLines, lrcLines, positionMs }: LyricsOverlayProps) {
  const totalLines = (karaokeLines?.length ?? 0) + lrcLines.length;
  const [, setFrame] = useState(0);

  useEffect(() => {
    if (totalLines === 0) {
      return;
    }
    const intervalId = globalThis.setInterval(() => {
      setFrame((frame) => frame + 1);
    }, 200);
    return () => globalThis.clearInterval(intervalId);
  }, [totalLines]);

  if (totalLines === 0) {
    return null;
  }

  if (karaokeLines && karaokeLines.length > 0) {
    return <KaraokeOverlay lines={karaokeLines} positionMs={positionMs} />;
  }
  return <LrcSweepOverlay lines={lrcLines} positionMs={positionMs} />;
}

// 逐字点亮:当前行内每个字按 word.startMs 是否到达变色,正在唱的字加亮放大。
function KaraokeOverlay({ lines, positionMs }: { lines: readonly KaraokeLine[]; positionMs: number }) {
  const index = activeKaraokeLineIndex(lines, positionMs);
  // 演唱前(index=-1)显示第一行(全部未点亮),让用户提前看到开口第一句
  const current = index >= 0 ? lines[index] ?? null : lines[0] ?? null;
  const previous = index >= 1 ? lines[index - 1] ?? null : null;
  // index=-1 时第一行已作为"当前行"显示,next 必须从下一行取,否则首行重复出现
  const next = lines[Math.max(index, 0) + 1] ?? null;
  const activeWordIndex = current
    ? current.words.findIndex((word) => positionMs >= word.startMs && positionMs < word.endMs)
    : -1;

  return (
    <div aria-label="同步歌词" style={styles.overlay}>
      <span style={styles.linePrevious}>{previous?.text ?? ""}</span>
      <span style={styles.lineCurrent}>
        {current && current.words.length === 0
          ? current.text
          : (current?.words ?? []).map((word, wordIndex) => {
              const sung = positionMs >= word.startMs;
              const active = wordIndex === activeWordIndex;
              return (
                <span
                  key={`${wordIndex}-${word.text}`}
                  style={{
                    ...styles.word,
                    color: sung ? tvTheme.colors.accent : tvTheme.colors.textMuted,
                    ...(active ? styles.wordActive : null)
                  }}
                >
                  {word.text}
                </span>
              );
            })}
      </span>
      <span style={styles.lineNext}>{next?.text ?? ""}</span>
    </div>
  );
}

// 行级 LRC 扫光降级:双色渐变按行内进度扫过整行。
function LrcSweepOverlay({ lines, positionMs }: { lines: readonly LrcLine[]; positionMs: number }) {
  const index = activeLyricIndex(lines, positionMs);
  const current = index >= 0 ? lines[index] ?? null : lines[0] ?? null;
  const previous = index >= 1 ? lines[index - 1] ?? null : null;
  const next = lines[Math.max(index, 0) + 1] ?? null;

  const span = current ? lyricLineSpan(lines, index >= 0 ? index : 0) : null;
  const progress = span ? lyricLineProgress(span, positionMs) : 0;
  const sweepPercent = Math.round(progress * 1000) / 10;

  return (
    <div aria-label="同步歌词" style={styles.overlay}>
      <span style={styles.linePrevious}>{previous?.text ?? ""}</span>
      <span style={sweepLineStyles(sweepPercent)}>{current?.text ?? ""}</span>
      <span style={styles.lineNext}>{next?.text ?? ""}</span>
    </div>
  );
}

function sweepLineStyles(percent: number): CSSProperties {
  return {
    backgroundImage: `linear-gradient(90deg, ${tvTheme.colors.accent} 0%, ${tvTheme.colors.accent} ${percent}%, ${tvTheme.colors.textMuted} ${percent}%, ${tvTheme.colors.textMuted} 100%)`,
    WebkitBackgroundClip: "text",
    backgroundClip: "text",
    color: "transparent",
    display: "block",
    fontSize: 42,
    fontWeight: 950,
    letterSpacing: 1,
    lineHeight: 1.2,
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap"
  };
}

const styles = {
  overlay: {
    alignItems: "flex-start",
    bottom: 132,
    display: "grid",
    filter: "drop-shadow(0 6px 24px rgba(0, 0, 0, 0.85))",
    gap: 10,
    justifyItems: "start",
    left: 24,
    maxWidth: "min(920px, calc(100vw - 48px))",
    minWidth: 0,
    // 纯展示层,不能挡住快进/快退热区的点按
    pointerEvents: "none",
    position: "absolute",
    zIndex: 2
  },
  lineCurrent: {
    color: tvTheme.colors.text,
    display: "block",
    fontSize: 42,
    fontWeight: 950,
    letterSpacing: 1,
    lineHeight: 1.2,
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap"
  },
  word: {
    display: "inline-block",
    transition: "color 120ms linear, text-shadow 120ms linear, transform 120ms ease-out"
  },
  wordActive: {
    textShadow: "0 0 18px rgba(34, 211, 238, 0.75)",
    transform: "scale(1.08)"
  },
  linePrevious: {
    color: tvTheme.colors.textWeak,
    filter: "opacity(0.55)",
    fontSize: 22,
    fontWeight: 700,
    lineHeight: 1.25,
    maxWidth: "100%",
    minHeight: "1em",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap"
  },
  lineNext: {
    color: tvTheme.colors.textMuted,
    filter: "opacity(0.8)",
    fontSize: 26,
    fontWeight: 800,
    lineHeight: 1.25,
    maxWidth: "100%",
    minHeight: "1em",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap"
  }
} satisfies Record<string, CSSProperties>;
