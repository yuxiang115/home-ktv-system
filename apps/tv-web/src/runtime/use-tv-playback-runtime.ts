import type { PlaybackNotice, RoomSnapshot } from "@home-ktv/player-contracts";
import type { RoomInteractionEvent } from "@home-ktv/player-contracts";
import type { Dispatch, MutableRefObject, RefObject, SetStateAction, SyntheticEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivePlaybackController, isSamePlaybackTarget } from "./active-playback-controller.js";
import { HeartbeatController } from "./heartbeat-controller.js";
import { createBrowserPlayerClient } from "./player-client.js";
import { RecoveryController } from "./recovery-controller.js";
import { SwitchController } from "./switch-controller.js";
import { useRoomSnapshot, type RoomSnapshotState } from "./use-room-snapshot.js";
import { createBrowserVideoPool, type DualVideoPool, type KtvVideoElement } from "./video-pool.js";
import { parseLrc, type LrcLine } from "./lrc.js";
import { parseKaraokeLyrics, type KaraokeLine } from "./karaoke.js";
import {
  advanceSeekBurst,
  resolveSeekTargetMs,
  SEEK_COMMIT_DELAY_MS,
  SEEK_FEEDBACK_TTL_MS,
  SEEK_STEP_MS,
  type SeekBounds,
  type SeekBurst,
  type SeekFeedback
} from "./seek.js";

const HEARTBEAT_INTERVAL_MS = 10_000;
const TRANSIENT_NOTICE_TTL_MS = 5_000;

export interface UseTvPlaybackRuntimeInput {
  activeVideoRef: RefObject<HTMLVideoElement | null>;
  standbyVideoRef: RefObject<HTMLVideoElement | null>;
}

export interface TvPlaybackRuntimeState {
  durationMs: number | null;
  /** 实时读取当前播放位置(毫秒);引用稳定,供逐帧驱动的渲染层(歌词扫光 rAF)调用 */
  getPositionMs(): number;
  firstPlayBlocked: boolean;
  handleFirstPlayPromptClick(): void;
  handleVideoEnded(event: SyntheticEvent<HTMLVideoElement>): void;
  interactions: readonly RoomInteractionEvent[];
  /** 当前歌的同步歌词(无歌词为 null);跟随 playbackPositionMs 渲染 */
  lyricLines: readonly LrcLine[] | null;
  /** 当前歌的逐字 karaoke 时间轴(无则 null);优先于 lyricLines 渲染 */
  karaokeLines: readonly KaraokeLine[] | null;
  localPlaybackConfirmed: boolean;
  /** 快进/快退累积反馈(无进行中的快进快退为 null) */
  seekFeedback: SeekFeedback | null;
  /** 累积一次 ±步长;停顿后统一提交到视频(键盘/热区共用入口) */
  nudgeSeek(deltaMs: number): void;
  playbackPositionMs: number;
  roomState: RoomSnapshotState;
  snapshot: RoomSnapshot | null;
}

export function useTvPlaybackRuntime(input: UseTvPlaybackRuntimeInput): TvPlaybackRuntimeState {
  const [client] = useState(() => createBrowserPlayerClient());
  const roomState = useRoomSnapshot(client);
  const latestSnapshotRef = useRef<RoomSnapshot | null>(null);
  const videoPoolRef = useRef<DualVideoPool | null>(null);
  const vocalModeSwitchInFlightRef = useRef(false);
  const sentPlaybackTelemetryRef = useRef<Set<string>>(new Set());
  const [localNotice, setLocalNotice] = useState<PlaybackNotice | null>(null);
  const [firstPlayBlocked, setFirstPlayBlocked] = useState(false);
  const [confirmedPlaybackTargetKey, setConfirmedPlaybackTargetKey] = useState<string | null>(null);
  const [lyrics, setLyrics] = useState<{ assetId: string; lines: LrcLine[] } | null>(null);
  const [karaoke, setKaraoke] = useState<{ assetId: string; lines: KaraokeLine[] } | null>(null);
  const lyricsCacheRef = useRef<Map<string, LrcLine[]>>(new Map());
  const karaokeCacheRef = useRef<Map<string, KaraokeLine[]>>(new Map());
  const [, setPlaybackFrame] = useState(0);
  const [seekFeedback, setSeekFeedback] = useState<SeekFeedback | null>(null);
  const seekBurstRef = useRef<SeekBurst | null>(null);
  const seekCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seekHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 最近一次已应用的服务端 seek 序列号;心跳只更新位置不动 seekSeq,故无回环
  const appliedSeekSeqRef = useRef<number | null>(null);

  useEffect(() => {
    latestSnapshotRef.current = roomState.snapshot;
  }, [roomState.snapshot]);

  useEffect(() => {
    if (!input.activeVideoRef.current || !input.standbyVideoRef.current || videoPoolRef.current) {
      return;
    }

    videoPoolRef.current = createBrowserVideoPool(input.activeVideoRef.current, input.standbyVideoRef.current);
  }, [input.activeVideoRef, input.standbyVideoRef]);

  useEffect(() => {
    const pool = videoPoolRef.current;
    const snapshot = roomState.snapshot;
    if (!pool || !snapshot) {
      return;
    }

    void synchronizePlayback({
      client,
      pool,
      snapshot,
      setFirstPlayBlocked,
      setConfirmedPlaybackTargetKey,
      sentPlaybackTelemetryRef,
      setLocalNotice,
      switchInFlightRef: vocalModeSwitchInFlightRef
    });
  }, [client, roomState.snapshot]);

  useEffect(() => {
    if (roomState.status === "error" || !roomState.snapshot?.currentTarget) {
      setFirstPlayBlocked(false);
      setConfirmedPlaybackTargetKey(null);
    }
  }, [roomState.status, roomState.snapshot?.currentTarget?.queueEntryId]);

  useEffect(() => {
    if (!isTransientLocalNotice(localNotice)) {
      return;
    }

    const timeoutId = globalThis.setTimeout(() => {
      setLocalNotice((current) => (current === localNotice ? null : current));
    }, TRANSIENT_NOTICE_TTL_MS);

    return () => globalThis.clearTimeout(timeoutId);
  }, [localNotice]);

  useEffect(() => {
    if (!roomState.snapshot?.currentTarget) {
      return;
    }

    // 200ms 驱动进度显示(时钟 + KTV 歌词跟随);1s 粒度歌词会一顿一顿
    const intervalId = globalThis.setInterval(() => {
      setPlaybackFrame((frame) => frame + 1);
    }, 200);

    return () => globalThis.clearInterval(intervalId);
  }, [roomState.snapshot?.currentTarget?.queueEntryId]);

  // 按歌拉歌词:先试逐字 karaoke JSON,拿不到再退行级 LRC(各自缓存,404 也缓存,
  // 避免对同一首歌反复请求;网络/服务端错误不缓存,下次进歌重试)。
  const currentAssetId = roomState.snapshot?.currentTarget?.assetId ?? null;
  useEffect(() => {
    if (!currentAssetId) {
      setLyrics(null);
      setKaraoke(null);
      return;
    }

    // 换歌先清旧词:加载窗口和"新歌无逐字轴"期间绝不能残留上一首的歌词
    setKaraoke(null);
    setLyrics(null);

    let cancelled = false;
    const cachedKaraoke = karaokeCacheRef.current.get(currentAssetId);
    const cachedLrc = lyricsCacheRef.current.get(currentAssetId);
    if (cachedKaraoke) {
      setKaraoke({ assetId: currentAssetId, lines: cachedKaraoke });
    }
    if (cachedLrc) {
      setLyrics(cachedLrc.length > 0 ? { assetId: currentAssetId, lines: cachedLrc } : null);
    }
    if (cachedKaraoke || cachedLrc) {
      return;
    }

    // 请求失败(非 404)时保持已清空的歌词且不写缓存,避免一次网络抖动把该歌
    // 在整个会话内判成"无歌词"
    void client.fetchKaraokeLyrics(currentAssetId)
      .then((karaokeJson) => {
        const parsed = karaokeJson ? parseKaraokeLyrics(karaokeJson) : null;
        karaokeCacheRef.current.set(currentAssetId, parsed ?? []);
        if (cancelled) {
          return;
        }
        if (parsed) {
          setKaraoke({ assetId: currentAssetId, lines: parsed });
          return;
        }
        void client.fetchSongLyrics(currentAssetId)
          .then((lrcContent) => {
            const lrcLines = lrcContent ? parseLrc(lrcContent) : [];
            lyricsCacheRef.current.set(currentAssetId, lrcLines);
            if (!cancelled) {
              setLyrics(lrcLines.length > 0 ? { assetId: currentAssetId, lines: lrcLines } : null);
            }
          })
          .catch(() => undefined);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, currentAssetId]);

  const retryCurrentPlayback = useCallback(() => {
    const pool = videoPoolRef.current;
    const snapshot = latestSnapshotRef.current;
    if (!pool || !snapshot) {
      return;
    }

    void synchronizePlayback({
      client,
      pool,
      snapshot,
      setFirstPlayBlocked,
      setConfirmedPlaybackTargetKey,
      sentPlaybackTelemetryRef,
      setLocalNotice,
      switchInFlightRef: vocalModeSwitchInFlightRef
    });
  }, [client]);

  useEffect(() => {
    const handlePointerDown = () => {
      retryCurrentPlayback();
    };

    globalThis.addEventListener("pointerdown", handlePointerDown);
    return () => globalThis.removeEventListener("pointerdown", handlePointerDown);
  }, [retryCurrentPlayback]);

  useEffect(() => {
    const sendHeartbeat = () => {
      const pool = videoPoolRef.current;
      const snapshot = latestSnapshotRef.current;
      if (!pool || !snapshot) {
        return;
      }

      void new HeartbeatController({ client, videoPool: pool }).send(snapshot);
    };

    const intervalId = globalThis.setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
    return () => globalThis.clearInterval(intervalId);
  }, [client]);

  const commitSeekBurst = useCallback((burst: SeekBurst) => {
    const pool = videoPoolRef.current;
    if (!pool) {
      setSeekFeedback(null);
      return;
    }
    const bounds = seekBoundsOfPool(pool);
    const targetMs = resolveSeekTargetMs(burst.fromMs + burst.totalMs, bounds);
    // remux 兜底流的 currentTime 是"流内位置",换算要扣掉歌内位置基准
    const streamSeconds = (targetMs - bounds.streamStartMs) / 1000;
    if (Number.isFinite(pool.activeVideo.currentTime)) {
      pool.activeVideo.currentTime = Math.max(0, streamSeconds);
    }
    setSeekFeedback({ ...burst, toMs: targetMs });
    seekHideTimerRef.current = globalThis.setTimeout(() => {
      setSeekFeedback(null);
    }, SEEK_FEEDBACK_TTL_MS);
  }, []);

  const nudgeSeek = useCallback(
    (deltaMs: number) => {
      const pool = videoPoolRef.current;
      const currentSnapshot = latestSnapshotRef.current;
      if (deltaMs === 0 || !pool || !currentSnapshot?.currentTarget) {
        return;
      }

      const burst = advanceSeekBurst(seekBurstRef.current, deltaMs, pool.activePlaybackPositionMs());
      seekBurstRef.current = burst;
      // 提交前反馈的是按边界收敛后的预览位置
      setSeekFeedback({
        ...burst,
        toMs: resolveSeekTargetMs(burst.fromMs + burst.totalMs, seekBoundsOfPool(pool))
      });
      if (seekHideTimerRef.current != null) {
        globalThis.clearTimeout(seekHideTimerRef.current);
        seekHideTimerRef.current = null;
      }
      if (seekCommitTimerRef.current != null) {
        globalThis.clearTimeout(seekCommitTimerRef.current);
      }
      seekCommitTimerRef.current = globalThis.setTimeout(() => {
        seekBurstRef.current = null;
        seekCommitTimerRef.current = null;
        commitSeekBurst(burst);
      }, SEEK_COMMIT_DELAY_MS);
    },
    [commitSeekBurst]
  );

  // 遥控器/键盘左右键 = 快退/快进一步;重复连按在 nudgeSeek 里累积
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }
      if (event.key === "ArrowRight") {
        nudgeSeek(SEEK_STEP_MS);
      } else if (event.key === "ArrowLeft") {
        nudgeSeek(-SEEK_STEP_MS);
      } else {
        return;
      }
      event.preventDefault();
    };

    globalThis.addEventListener("keydown", handleKeyDown);
    return () => globalThis.removeEventListener("keydown", handleKeyDown);
  }, [nudgeSeek]);

  // 手机端 seek:服务端在快照 currentTarget 里用 seekSeq+resumePositionMs 表达,
  // 序列号变化时把进度应用到视频(边界收敛与本地 seek 共用一套逻辑)
  const remoteSeekSeq = roomState.snapshot?.currentTarget?.seekSeq ?? null;
  const remoteSeekTargetMs = roomState.snapshot?.currentTarget?.resumePositionMs ?? null;
  useEffect(() => {
    const pool = videoPoolRef.current;
    if (remoteSeekSeq == null || remoteSeekTargetMs == null || !pool || !roomState.snapshot?.currentTarget) {
      return;
    }
    if (appliedSeekSeqRef.current === remoteSeekSeq) {
      return;
    }
    const firstObservation = appliedSeekSeqRef.current == null;
    appliedSeekSeqRef.current = remoteSeekSeq;
    // 首次观察(页面打开/换歌重 prime)不回放历史 seek,prime 已对齐位置
    if (firstObservation) {
      return;
    }

    const bounds = seekBoundsOfPool(pool);
    const targetMs = resolveSeekTargetMs(remoteSeekTargetMs, bounds);
    const fromMs = pool.activePlaybackPositionMs();
    if (Number.isFinite(pool.activeVideo.currentTime)) {
      pool.activeVideo.currentTime = Math.max(0, (targetMs - bounds.streamStartMs) / 1000);
    }
    const pressedMs = Math.abs(targetMs - fromMs);
    if (pressedMs >= 500) {
      setSeekFeedback({
        direction: targetMs >= fromMs ? "forward" : "backward",
        presses: Math.max(1, Math.round(pressedMs / 10_000)),
        totalMs: targetMs - fromMs,
        fromMs,
        toMs: targetMs
      });
      if (seekHideTimerRef.current != null) {
        globalThis.clearTimeout(seekHideTimerRef.current);
      }
      seekHideTimerRef.current = globalThis.setTimeout(() => {
        setSeekFeedback(null);
      }, SEEK_FEEDBACK_TTL_MS);
    }
  }, [remoteSeekSeq, remoteSeekTargetMs, roomState.snapshot?.currentTarget]);

  // 换歌/换音轨时清掉未提交的快进快退状态
  useEffect(() => {
    seekBurstRef.current = null;
    if (seekCommitTimerRef.current != null) {
      globalThis.clearTimeout(seekCommitTimerRef.current);
      seekCommitTimerRef.current = null;
    }
    if (seekHideTimerRef.current != null) {
      globalThis.clearTimeout(seekHideTimerRef.current);
      seekHideTimerRef.current = null;
    }
    setSeekFeedback(null);
  }, [
    roomState.snapshot?.currentTarget?.queueEntryId,
    roomState.snapshot?.currentTarget?.assetId,
    roomState.snapshot?.currentTarget?.vocalMode
  ]);


  useEffect(() => {
    const pool = videoPoolRef.current;
    const snapshot = roomState.snapshot;
    if (!pool || !snapshot || snapshot.state !== "recovering") {
      return;
    }

    const recoveryController = new RecoveryController({ client, videoPool: pool });
    void recoveryController.recover({ roomSlug: snapshot.roomSlug, deviceId: client.deviceId }).then((result) => {
      setLocalNotice(result.notice);
    });
  }, [client, roomState.snapshot]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const pool = videoPoolRef.current;
      const snapshot = roomState.snapshot;
      if (event.key.toLowerCase() !== "v" || !pool || !snapshot) {
        return;
      }

      const switchController = new SwitchController({ client, deviceId: client.deviceId, videoPool: pool });
      void switchController.switchVocalMode(snapshot).then((result) => {
        if (result.status === "reverted") {
          setLocalNotice({
            kind: "switch_failed_reverted",
            message: result.message
          });
        }
      });
    };

    globalThis.addEventListener("keydown", handleKeyDown);
    return () => globalThis.removeEventListener("keydown", handleKeyDown);
  }, [client, roomState.snapshot]);

  const handleVideoEnded = useCallback(
    (event: SyntheticEvent<HTMLVideoElement>) => {
      const pool = videoPoolRef.current;
      const snapshot = latestSnapshotRef.current;
      if (!pool || !snapshot || event.currentTarget !== pool.activeVideo) {
        return;
      }

      const target = pool.activeTarget ?? snapshot.currentTarget;
      if (!target) {
        return;
      }

      void client.sendTelemetry({
        roomSlug: snapshot.roomSlug,
        deviceId: client.deviceId,
        eventType: "ended",
        sessionVersion: target.sessionVersion,
        queueEntryId: target.queueEntryId,
        sourceType: target.sourceType,
        assetId: target.assetId,
        playbackPositionMs: endedPlaybackPositionMs(pool),
        vocalMode: target.vocalMode,
        switchFamily: target.switchFamily,
        rollbackAssetId: null,
        stage: "ended"
      });
    },
    [client]
  );

  // 实时位置读取:每次调用直接读 video.currentTime(经 pool),不受 runtime 200ms tick
  // 的 render 时机限制;歌词扫光的 rAF 循环用它逐帧取位置。空依赖保证引用稳定,
  // 无 pool 时的 fallback 走 latestSnapshotRef,不会闭包住旧快照。
  const getPositionMs = useCallback((): number => {
    const pool = videoPoolRef.current;
    if (pool) {
      return Math.max(0, pool.activePlaybackPositionMs());
    }
    return latestSnapshotRef.current?.currentTarget?.resumePositionMs ?? 0;
  }, []);

  const snapshot = mergeLocalNotice(roomState.snapshot, localNotice);
  const currentTargetKey = playbackTargetKey(snapshot?.currentTarget ?? null);
  const activeVideo = videoPoolRef.current?.activeVideo ?? null;
  const playbackPositionMs = activeVideo
    ? Math.max(0, videoPoolRef.current?.activePlaybackPositionMs() ?? Math.trunc(activeVideo.currentTime * 1000))
    : roomState.snapshot?.currentTarget?.resumePositionMs ?? 0;
  const durationMs =
    activeVideo && Number.isFinite(activeVideo.duration) ? Math.max(0, Math.trunc(activeVideo.duration * 1000)) : null;

  return {
    durationMs,
    firstPlayBlocked,
    getPositionMs,
    handleFirstPlayPromptClick: retryCurrentPlayback,
    handleVideoEnded,
    interactions: roomState.interactions,
    lyricLines: lyrics?.lines ?? null,
    karaokeLines: karaoke?.lines ?? null,
    localPlaybackConfirmed: Boolean(currentTargetKey && confirmedPlaybackTargetKey === currentTargetKey),
    seekFeedback,
    nudgeSeek,
    playbackPositionMs,
    roomState,
    snapshot
  };
}

// remux 兜底流的 duration 是"从切换点起的剩余时长",歌内总时长 = 基准 + 剩余
function seekBoundsOfPool(pool: DualVideoPool): SeekBounds {
  const video = pool.activeVideo;
  const durationMs =
    Number.isFinite(video.duration) && video.duration > 0 ? pool.activePositionBaseMs + Math.trunc(video.duration * 1000) : null;
  return { streamStartMs: pool.activePositionBaseMs, durationMs };
}

function mergeLocalNotice(snapshot: RoomSnapshot | null, localNotice: PlaybackNotice | null): RoomSnapshot | null {
  if (!snapshot || !localNotice) {
    return snapshot;
  }

  return {
    ...snapshot,
    notice: localNotice
  };
}

function isTransientLocalNotice(notice: PlaybackNotice | null): boolean {
  return (
    notice?.kind === "switch_failed_reverted" ||
    notice?.kind === "playback_failed_skipped" ||
    notice?.kind === "recovery_fallback_start_over"
  );
}

async function ensureCurrentPlayback(
  client: ReturnType<typeof createBrowserPlayerClient>,
  pool: DualVideoPool,
  snapshot: RoomSnapshot,
  sentPlaybackTelemetryRef: MutableRefObject<Set<string>>,
  setLocalNotice: Dispatch<SetStateAction<PlaybackNotice | null>>,
  setFirstPlayBlocked: Dispatch<SetStateAction<boolean>>,
  setConfirmedPlaybackTargetKey: Dispatch<SetStateAction<string | null>>
): Promise<void> {
  const result = await new ActivePlaybackController({ videoPool: pool }).ensurePlaying(snapshot);
  const target = snapshot.currentTarget;
  if (!target) {
    setFirstPlayBlocked(false);
    setConfirmedPlaybackTargetKey(null);
    return;
  }

  if (result.status === "blocked") {
    if (isPlaybackCapabilityBlockedMessage(result.message)) {
      setFirstPlayBlocked(false);
      setLocalNotice({
        kind: "playback_failed_skipped",
        message: `unsupported: ${result.message}`
      });
      await client.sendTelemetry({
        roomSlug: snapshot.roomSlug,
        deviceId: client.deviceId,
        eventType: "failed",
        sessionVersion: target.sessionVersion,
        queueEntryId: target.queueEntryId,
        sourceType: target.sourceType,
        assetId: target.assetId,
        playbackPositionMs: target.resumePositionMs,
        vocalMode: target.vocalMode,
        switchFamily: target.switchFamily,
        rollbackAssetId: null,
        message: result.message,
        errorCode: "TV_PLAYBACK_CAPABILITY_BLOCKED",
        stage: "playback_capability_blocked"
      });
      return;
    }

    setFirstPlayBlocked(true);
    setConfirmedPlaybackTargetKey(null);
    setLocalNotice({
      kind: "loading",
      message: "点击电视开始播放"
    });
    await sendPlaybackTelemetryOnce({
      client,
      eventType: "loading",
      message: result.message,
      playbackPositionMs: target.resumePositionMs,
      sentPlaybackTelemetryRef,
      snapshot,
      stage: "autoplay_blocked"
    });
    return;
  }

  if (result.status === "playing") {
    setFirstPlayBlocked(false);
    setConfirmedPlaybackTargetKey(playbackTargetKey(target));
    setLocalNotice((notice) => (notice?.kind === "loading" ? null : notice));
    await sendPlaybackTelemetryOnce({
      client,
      eventType: "playing",
      playbackPositionMs: pool.activePlaybackPositionMs(target.resumePositionMs),
      sentPlaybackTelemetryRef,
      snapshot,
      stage: "active_playback_started"
    });
  }
}

async function synchronizePlayback(input: {
  client: ReturnType<typeof createBrowserPlayerClient>;
  pool: DualVideoPool;
  setConfirmedPlaybackTargetKey: Dispatch<SetStateAction<string | null>>;
  setFirstPlayBlocked: Dispatch<SetStateAction<boolean>>;
  sentPlaybackTelemetryRef: MutableRefObject<Set<string>>;
  snapshot: RoomSnapshot;
  setLocalNotice: Dispatch<SetStateAction<PlaybackNotice | null>>;
  switchInFlightRef: MutableRefObject<boolean>;
}): Promise<void> {
  const targetVocalMode = input.snapshot.targetVocalMode ?? input.snapshot.currentTarget?.vocalMode ?? null;
  const currentVocalMode = input.snapshot.currentTarget?.vocalMode ?? null;
  const hasPendingVocalSwitch = Boolean(input.snapshot.currentTarget && targetVocalMode && targetVocalMode !== currentVocalMode);

  if (hasPendingVocalSwitch && !isCurrentPlaybackReadyForSwitch(input.pool, input.snapshot)) {
    await ensureCurrentPlayback(
      input.client,
      input.pool,
      input.snapshot,
      input.sentPlaybackTelemetryRef,
      input.setLocalNotice,
      input.setFirstPlayBlocked,
      input.setConfirmedPlaybackTargetKey
    );
    return;
  }

  if (hasPendingVocalSwitch) {
    if (input.switchInFlightRef.current) {
      return;
    }

    input.switchInFlightRef.current = true;
    try {
      const result = await new SwitchController({
        client: input.client,
        deviceId: input.client.deviceId,
        videoPool: input.pool
      }).switchVocalMode(input.snapshot);
      if (result.status === "reverted") {
        input.setLocalNotice({
          kind: "switch_failed_reverted",
          message: result.message
        });
      }
    } finally {
      input.switchInFlightRef.current = false;
    }
    return;
  }

  await ensureCurrentPlayback(
    input.client,
    input.pool,
    input.snapshot,
    input.sentPlaybackTelemetryRef,
    input.setLocalNotice,
    input.setFirstPlayBlocked,
    input.setConfirmedPlaybackTargetKey
  );
}

function isCurrentPlaybackReadyForSwitch(pool: DualVideoPool, snapshot: RoomSnapshot): boolean {
  return Boolean(snapshot.currentTarget) && isSamePlaybackTarget(pool.activeTarget, snapshot.currentTarget) && pool.activeVideo.paused === false;
}

async function sendPlaybackTelemetryOnce(input: {
  client: ReturnType<typeof createBrowserPlayerClient>;
  eventType: "loading" | "playing";
  message?: string;
  playbackPositionMs: number;
  sentPlaybackTelemetryRef: MutableRefObject<Set<string>>;
  snapshot: RoomSnapshot;
  stage: "active_playback_started" | "autoplay_blocked";
}): Promise<void> {
  const target = input.snapshot.currentTarget;
  if (!target) {
    return;
  }

  const telemetryKey = [
    input.eventType,
    input.snapshot.roomSlug,
    target.queueEntryId,
    target.sourceType,
    target.assetId,
    target.vocalMode,
    input.stage
  ].join(":");
  if (input.sentPlaybackTelemetryRef.current.has(telemetryKey)) {
    return;
  }

  input.sentPlaybackTelemetryRef.current.add(telemetryKey);
  try {
    await input.client.sendTelemetry({
      roomSlug: input.snapshot.roomSlug,
      deviceId: input.client.deviceId,
      eventType: input.eventType,
      sessionVersion: target.sessionVersion,
      queueEntryId: target.queueEntryId,
      sourceType: target.sourceType,
      assetId: target.assetId,
      playbackPositionMs: input.playbackPositionMs,
      vocalMode: target.vocalMode,
      switchFamily: target.switchFamily,
      rollbackAssetId: null,
      ...(input.message ? { message: input.message } : {}),
      stage: input.stage
    });
  } catch {
    input.sentPlaybackTelemetryRef.current.delete(telemetryKey);
  }
}

function playbackTargetKey(target: RoomSnapshot["currentTarget"] | null): string | null {
  if (!target) {
    return null;
  }

  return [target.queueEntryId, target.sourceType, target.assetId, target.vocalMode].join(":");
}

// remux 兜底流的 duration 是"从切换点起的剩余时长",结束时补上位置基准得到真实进度。
function endedPlaybackPositionMs(pool: DualVideoPool): number {
  const video = pool.activeVideo;
  const positionSeconds = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : video.currentTime;
  return Math.max(0, Math.trunc(positionSeconds * 1000)) + pool.activePositionBaseMs;
}

function isPlaybackCapabilityBlockedMessage(message: string): boolean {
  return /audio-track switching|media-not-supported|cannot-play|preprocess|unsupported|not supported|no supported sources|notsupportederror|decode|demux|format/iu.test(message);
}
