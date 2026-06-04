import type { RoomSnapshot } from "@home-ktv/player-contracts";
import type { CSSProperties } from "react";
import { PairingQr } from "../components/PairingQr.js";
import { PlaybackStatusBanner } from "../components/PlaybackStatusBanner.js";
import { formatPlaybackClock, type TvDisplayState } from "./tv-display-model.js";
import { tvTheme } from "../theme.js";

export interface PlayingScreenProps {
  displayState: TvDisplayState;
  snapshot: RoomSnapshot;
  playbackPositionMs: number;
  durationMs: number | null;
  onFirstPlayPromptClick?: () => void;
}

export function PlayingScreen({ displayState, snapshot, playbackPositionMs, durationMs, onFirstPlayPromptClick }: PlayingScreenProps) {
  const target = snapshot.currentTarget;
  const modeLabel = modeLabelFor(target?.vocalMode ?? "unknown");
  const clock = formatPlaybackClock(playbackPositionMs, durationMs);
  const audioTrackLabel = audioTrackLabelFor(target?.selectedTrackRef ?? null);

  return (
    <section style={styles.screen}>
      <div style={styles.topRail}>
        <div style={styles.statusSlot}>
          <PlaybackStatusBanner notice={snapshot.notice} />
        </div>
        <PairingQr pairing={snapshot.pairing} variant="corner" />
      </div>
      <footer aria-label="播放状态" style={styles.footer}>
        <span style={styles.timeValue}>{clock}</span>
        <span style={styles.metaLine}>
          <span style={{ ...styles.modePill, ...modeAccent(target?.vocalMode ?? "unknown") }}>{modeLabel}</span>
          <span style={styles.audioTrackText}>{audioTrackLabel}</span>
          <span style={{ ...styles.stateText, ...stateAccent(displayState.tone) }}>{displayState.stateLabel}</span>
        </span>
      </footer>
      {displayState.firstPlayPrompt.visible ? (
        <div role="status" style={styles.firstPlayPrompt}>
          <button
            aria-label="点击电视开始播放"
            onClick={onFirstPlayPromptClick}
            onPointerDown={(event) => event.stopPropagation()}
            style={styles.promptButton}
            type="button"
          >
            {displayState.firstPlayPrompt.heading}
          </button>
          <p style={styles.promptBody}>{displayState.firstPlayPrompt.body}</p>
        </div>
      ) : null}
    </section>
  );
}

function modeLabelFor(vocalMode: string): string {
  if (vocalMode === "original") {
    return "原唱";
  }

  if (vocalMode === "instrumental") {
    return "伴唱";
  }

  if (vocalMode === "dual") {
    return "双轨";
  }

  return "未识别";
}

function audioTrackLabelFor(trackRef: NonNullable<RoomSnapshot["currentTarget"]>["selectedTrackRef"] | null): string {
  if (!trackRef) {
    return "音轨待确认";
  }

  const displayIndex = Number.isFinite(trackRef.index) ? trackRef.index + 1 : null;
  if (displayIndex !== null) {
    return `音轨 ${displayIndex}`;
  }

  return "音轨待确认";
}

function modeAccent(vocalMode: string): CSSProperties {
  if (vocalMode === "original") {
    return {
      color: tvTheme.colors.success
    };
  }

  if (vocalMode === "instrumental") {
    return {
      color: tvTheme.colors.accent
    };
  }

  return {
    color: tvTheme.colors.text
  };
}

function stateAccent(tone: TvDisplayState["tone"]): CSSProperties {
  if (tone === "danger") {
    return {
      color: tvTheme.colors.danger
    };
  }

  if (tone === "warning") {
    return {
      color: tvTheme.colors.warning
    };
  }

  if (tone === "ready") {
    return {
      color: tvTheme.colors.success
    };
  }

  return {
    color: tvTheme.colors.text
  };
}

const styles = {
  screen: {
    minHeight: "100vh",
    position: "relative"
  },
  topRail: {
    alignItems: "start",
    display: "flex",
    gap: 24,
    justifyContent: "space-between",
    left: 24,
    minWidth: 0,
    position: "absolute",
    right: 24,
    top: 24,
    zIndex: 3
  },
  statusSlot: {
    minWidth: 0
  },
  footer: {
    backdropFilter: "blur(16px)",
    background: "rgba(0, 0, 0, 0.5)",
    border: `1px solid ${tvTheme.colors.border}`,
    borderRadius: tvTheme.radii.panel,
    bottom: 22,
    boxShadow: "0 18px 64px rgba(0, 0, 0, 0.32)",
    color: tvTheme.colors.text,
    display: "grid",
    gap: 8,
    left: 24,
    maxWidth: "min(720px, calc(100vw - 48px))",
    minWidth: 0,
    padding: "14px 20px 15px",
    position: "absolute",
    zIndex: 3
  },
  timeValue: {
    color: tvTheme.colors.text,
    display: "block",
    fontSize: 32,
    fontWeight: 950,
    lineHeight: 1,
    whiteSpace: "nowrap"
  },
  metaLine: {
    alignItems: "center",
    color: tvTheme.colors.textMuted,
    display: "flex",
    flexWrap: "wrap",
    fontSize: 18,
    fontWeight: 760,
    gap: 10,
    lineHeight: 1.2,
    minWidth: 0,
    overflowWrap: "anywhere"
  },
  modePill: {
    fontWeight: 900
  },
  audioTrackText: {
    color: tvTheme.colors.textMuted,
    minWidth: 0
  },
  stateText: {
    fontWeight: 850
  },
  firstPlayPrompt: {
    backdropFilter: "blur(18px)",
    background: tvTheme.colors.surface,
    border: "1px solid rgba(251, 191, 36, 0.46)",
    borderRadius: tvTheme.radii.panel,
    boxShadow: "0 24px 80px rgba(0, 0, 0, 0.42)",
    left: "50%",
    maxWidth: 720,
    padding: "28px 32px",
    position: "absolute",
    textAlign: "center",
    top: "50%",
    transform: "translate(-50%, -50%)",
    width: "min(720px, calc(100vw - 128px))"
  },
  promptButton: {
    appearance: "none",
    background: "transparent",
    border: 0,
    color: tvTheme.colors.warning,
    cursor: "pointer",
    display: "block",
    fontFamily: tvTheme.fonts.heading,
    fontSize: 44,
    fontWeight: 950,
    letterSpacing: 0,
    lineHeight: 1.08,
    margin: 0,
    overflowWrap: "anywhere"
  },
  promptBody: {
    color: tvTheme.colors.text,
    fontSize: 28,
    fontWeight: 800,
    lineHeight: 1.25,
    margin: "18px 0 0",
    overflowWrap: "anywhere"
  }
} satisfies Record<string, CSSProperties>;
