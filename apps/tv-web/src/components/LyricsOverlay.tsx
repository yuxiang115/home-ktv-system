import type { CSSProperties } from "react";
import { Fragment, useEffect, useRef, useState } from "react";
import {
  activeKaraokeLineIndex,
  karaokeWordNeedsSpace,
  karaokeWordProgress,
  type KaraokeLine,
  type KaraokeWord
} from "../runtime/karaoke.js";
import { activeLyricIndex, lyricLineProgress, lyricLineSpan, type LrcLine } from "../runtime/lrc.js";
import { tvTheme } from "../theme.js";

export interface LyricsOverlayProps {
  karaokeLines: readonly KaraokeLine[] | null;
  lrcLines: readonly LrcLine[];
  positionMs: number;
  /** 实时位置回调(优先于 positionMs):提供时组件按 rAF 每帧读取当帧位置,扫光连续推进 */
  getPositionMs?: () => number;
}

// KTV 式同步歌词:有逐字时间轴时词内扫光(已唱亮色、未唱底色、正在唱的词按词内
// 进度渐变);只有行级 LRC 时退化为整行扫光(行内线性插值)。提供 getPositionMs 时
// 用 rAF 每帧实时读取位置(原生 KTV 的连续感);否则 100ms 自刷新跟随 positionMs。
export function LyricsOverlay({ karaokeLines, lrcLines, positionMs, getPositionMs }: LyricsOverlayProps) {
  const totalLines = (karaokeLines?.length ?? 0) + lrcLines.length;
  const [, setFrame] = useState(0);
  // rAF 路径的当帧位置;null = 首帧还没到/未提供回调,先退 positionMs prop
  const [livePositionMs, setLivePositionMs] = useState<number | null>(null);
  const getPositionMsRef = useRef(getPositionMs);
  const hasReader = Boolean(getPositionMs);

  useEffect(() => {
    getPositionMsRef.current = getPositionMs;
  }, [getPositionMs]);

  useEffect(() => {
    if (totalLines === 0) {
      return;
    }

    // 兼容路径(未提供实时回调):保持原有 interval 自刷新,渲染读取 positionMs prop
    if (!hasReader) {
      const intervalId = globalThis.setInterval(() => {
        setFrame((frame) => frame + 1);
      }, 100);
      return () => globalThis.clearInterval(intervalId);
    }

    const readPosition = () => {
      const reader = getPositionMsRef.current;
      if (reader) {
        setLivePositionMs(reader());
      }
    };

    // 实时路径:优先 rAF,每帧读当帧位置;测试环境无 rAF(或返回假句柄)时
    // 退化为 interval 读取
    if (typeof globalThis.requestAnimationFrame === "function") {
      let frameHandle: number | null = null;
      let stopped = false;
      const tick = () => {
        if (stopped) {
          return;
        }
        readPosition();
        frameHandle = globalThis.requestAnimationFrame(tick);
      };
      frameHandle = globalThis.requestAnimationFrame(tick);
      if (frameHandle != null) {
        return () => {
          stopped = true;
          if (frameHandle != null) {
            globalThis.cancelAnimationFrame(frameHandle);
          }
        };
      }
      // rAF 返回假句柄:该环境不可用,停掉试探帧,落到 interval
      stopped = true;
    }

    const intervalId = globalThis.setInterval(readPosition, 100);
    return () => globalThis.clearInterval(intervalId);
  }, [totalLines, hasReader]);

  if (totalLines === 0) {
    return null;
  }

  const effectivePositionMs = hasReader ? (livePositionMs ?? positionMs) : positionMs;

  if (karaokeLines && karaokeLines.length > 0) {
    return <KaraokeOverlay lines={karaokeLines} positionMs={effectivePositionMs} />;
  }
  return <LrcSweepOverlay lines={lrcLines} positionMs={effectivePositionMs} />;
}

// 词内扫光:当前行内已唱词纯亮色、未唱纯底色;正在唱的词按词内进度双色渐变扫过。
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
          : (current?.words ?? []).map((word, wordIndex) => (
              <Fragment key={`${wordIndex}-${word.text}`}>
                <KaraokeWordSpan
                  word={word}
                  active={wordIndex === activeWordIndex}
                  positionMs={positionMs}
                />
                {/* 词是 inline-block,JSX 空白会被浏览器吞掉:非 CJK(空格分词语言)
                    的词在 inline-block 之外补一个文本空格,英文才不会粘成 "Whenyou" */}
                {karaokeWordNeedsSpace(word.text) ? " " : null}
              </Fragment>
            ))}
      </span>
      <span style={styles.lineNext}>{next?.text ?? ""}</span>
    </div>
  );
}

// 单个词:未唱纯 muted、已唱纯 accent;正在唱的词用词内扫光渐变 + 亮光放大。
function KaraokeWordSpan({
  word,
  active,
  positionMs
}: {
  word: KaraokeWord;
  active: boolean;
  positionMs: number;
}) {
  if (!active) {
    return (
      <span
        style={{
          ...styles.word,
          color: positionMs >= word.startMs ? tvTheme.colors.accent : tvTheme.colors.textMuted
        }}
      >
        {word.text}
      </span>
    );
  }

  // CSS 渐变百分比支持小数,保留浮点精度让扫光逐帧平滑(不量化到 0.1%)
  const sweepPercent = karaokeWordProgress(word, positionMs) * 100;
  return (
    <span style={{ ...styles.word, ...wordSweepStyles(sweepPercent), ...styles.wordActive }}>
      {word.text}
    </span>
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
  // CSS 渐变百分比支持小数,保留浮点精度让扫光逐帧平滑(不量化到 0.1%)
  const sweepPercent = progress * 100;

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

// 词内扫光(与 sweepLineStyles 同一写法,只是不带行级排版):双色渐变按词内进度
// 扫过单个词。progress=0 时整词 muted、progress=1 时整词 accent,与两侧纯色词
// 无缝衔接,所以 color 过渡反而会造成双重上色,这里不做 color 过渡。
function wordSweepStyles(percent: number): CSSProperties {
  return {
    backgroundImage: `linear-gradient(90deg, ${tvTheme.colors.accent} 0%, ${tvTheme.colors.accent} ${percent}%, ${tvTheme.colors.textMuted} ${percent}%, ${tvTheme.colors.textMuted} 100%)`,
    WebkitBackgroundClip: "text",
    backgroundClip: "text",
    color: "transparent"
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
    // color 不做过渡:扫光渐变在 progress 0/1 处恰好等于两侧的 muted/accent 纯色
    transition: "text-shadow 120ms linear, transform 120ms ease-out"
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
