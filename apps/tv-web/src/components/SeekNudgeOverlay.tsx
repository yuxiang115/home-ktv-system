import type { CSSProperties } from "react";
import { useRef } from "react";
import {
  formatSeekClock,
  SEEK_DOUBLE_TAP_MS,
  SEEK_MAX_CHEVRONS,
  type SeekFeedback
} from "../runtime/seek.js";
import { tvTheme } from "../theme.js";

// YouTube 风格快进/快退反馈:方向侧的胶囊里,箭头数量随连按次数增长,
// 显示累计秒数与"当前位置 → 目标位置"。纯展示,pointer-events 关闭。
export function SeekNudgeOverlay({ feedback }: { feedback: SeekFeedback | null }) {
  if (!feedback) {
    return null;
  }

  const forward = feedback.direction === "forward";
  const seconds = Math.round(Math.abs(feedback.totalMs) / 1000);
  const chevrons = (forward ? "›" : "‹").repeat(Math.min(feedback.presses, SEEK_MAX_CHEVRONS));
  const label = forward ? "快进" : "快退";

  return (
    <div aria-label={`seek ${label}`} style={styles.wrap}>
      <div style={forward ? { ...styles.pill, ...styles.pillRight } : styles.pill}>
        {!forward ? <span style={styles.chevrons}>{chevrons}</span> : null}
        <span style={styles.label}>{`${label} ${seconds}秒`}</span>
        {forward ? <span style={styles.chevrons}>{chevrons}</span> : null}
        <span style={styles.clock}>
          {`${formatSeekClock(feedback.fromMs)} → ${formatSeekClock(feedback.toMs)}`}
        </span>
      </div>
    </div>
  );
}

// 屏幕左右侧的连点热区:同一侧 350ms 内的第二次及后续点按各触发一次步长
// (第一次点按不生效,与手机 YouTube 双击快进一致,避免误触)。
export function SeekHotzone({ side, onNudge }: { side: "left" | "right"; onNudge: () => void }) {
  const lastTapRef = useRef(0);

  return (
    <div
      aria-hidden
      onPointerDown={() => {
        const now = Date.now();
        if (now - lastTapRef.current <= SEEK_DOUBLE_TAP_MS) {
          onNudge();
        }
        lastTapRef.current = now;
      }}
      style={side === "left" ? styles.zoneLeft : styles.zoneRight}
    />
  );
}

const styles = {
  wrap: {
    alignItems: "center",
    display: "flex",
    inset: 0,
    pointerEvents: "none",
    position: "absolute",
    zIndex: 3
  },
  pill: {
    alignItems: "center",
    backdropFilter: "blur(10px)",
    background: "rgba(6, 10, 20, 0.72)",
    border: `1px solid ${tvTheme.colors.accent}`,
    borderRadius: 999,
    boxShadow: "0 10px 34px rgba(0, 0, 0, 0.55)",
    color: tvTheme.colors.text,
    display: "flex",
    gap: 14,
    marginLeft: 36,
    padding: "16px 30px",
    transform: "translateY(-50%)",
    top: "50%"
  },
  pillRight: {
    marginLeft: "auto",
    marginRight: 36
  },
  chevrons: {
    color: tvTheme.colors.accent,
    fontSize: 44,
    fontWeight: 950,
    letterSpacing: 2,
    lineHeight: 1,
    textShadow: "0 0 18px rgba(34, 211, 238, 0.65)"
  },
  label: {
    fontSize: 30,
    fontWeight: 950,
    whiteSpace: "nowrap"
  },
  clock: {
    color: tvTheme.colors.textMuted,
    fontSize: 24,
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap"
  },
  zoneLeft: {
    bottom: 0,
    cursor: "pointer",
    left: 0,
    position: "absolute",
    top: 0,
    width: "28%",
    zIndex: 2
  },
  zoneRight: {
    bottom: 0,
    cursor: "pointer",
    position: "absolute",
    right: 0,
    top: 0,
    width: "28%",
    zIndex: 2
  }
} satisfies Record<string, CSSProperties>;
