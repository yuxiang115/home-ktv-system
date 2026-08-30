import type {
  PlayerTelemetryKind,
  RoomSnapshot,
  SwitchTarget,
  SwitchTransitionResult
} from "@home-ktv/player-contracts";
import type { AudioTrackSelectionResult, DualVideoPool } from "./video-pool.js";
import { isSamePlaybackTarget } from "./active-playback-controller.js";
import { selectAudioTrack } from "./video-pool.js";

type VocalMode = NonNullable<RoomSnapshot["currentTarget"]>["vocalMode"];

export interface SwitchRuntimeClient {
  requestSwitchTransition(input: { roomSlug: string; playbackPositionMs: number }): Promise<SwitchTransitionResult>;
  sendTelemetry(input: {
    roomSlug: string;
    deviceId: string;
    eventType: PlayerTelemetryKind;
    sessionVersion: number;
    queueEntryId: string;
    sourceType: NonNullable<RoomSnapshot["currentTarget"]>["sourceType"];
    assetId: string;
    playbackPositionMs: number;
    vocalMode: VocalMode;
    switchFamily: string | null;
    rollbackAssetId: string | null;
    message?: string;
    stage?: string;
  }): Promise<void>;
}

export type SwitchRuntimeResult =
  | { status: "committed"; switchTarget: SwitchTarget }
  | { status: "reverted"; switchTarget: SwitchTarget; message: string }
  | { status: "unavailable"; reason: string }
  | { status: "disabled"; reason: "no-current-target" };

export interface SwitchControllerInput {
  client: SwitchRuntimeClient;
  videoPool: DualVideoPool;
  deviceId?: string;
  /** remux 兜底流 start 提前量探测(入参为带 offsetProbe=1 的探测 URL,默认 fetch 拿头/JSON);测试注入 fake */
  startOffsetProbe?: (probeUrl: string) => Promise<number | null>;
}

export class SwitchController {
  private readonly client: SwitchRuntimeClient;
  private readonly deviceId: string;
  private readonly videoPool: DualVideoPool;
  private readonly startOffsetProbe: (probeUrl: string) => Promise<number | null>;

  constructor(input: SwitchControllerInput) {
    this.client = input.client;
    this.videoPool = input.videoPool;
    this.deviceId = input.deviceId ?? "tv-player";
    this.startOffsetProbe = input.startOffsetProbe ?? probeRemuxStartOffsetMs;
  }

  async switchVocalMode(snapshot: RoomSnapshot): Promise<SwitchRuntimeResult> {
    if (!canAttemptRuntimePlayback(snapshot)) {
      this.videoPool.disable();
      return {
        status: "disabled",
        reason: "no-current-target"
      };
    }

    if (snapshot.currentTarget && !isSamePlaybackTarget(this.videoPool.activeTarget, snapshot.currentTarget)) {
      this.videoPool.primeActive(snapshot.currentTarget);
    }

    const playbackPositionMs = this.videoPool.activePlaybackPositionMs();
    const transition = await this.client.requestSwitchTransition({
      roomSlug: snapshot.roomSlug,
      playbackPositionMs
    });

    if (transition.status !== "ready" || !transition.switchTarget) {
      return {
        status: "unavailable",
        reason: transition.reason ?? "SWITCH_TARGET_NOT_AVAILABLE"
      };
    }

    if (transition.switchTarget.switchKind === "audio_track") {
      return this.commitAudioTrackSwitch(snapshot, transition.switchTarget);
    }

    try {
      this.videoPool.prepareStandby(transition.switchTarget);
      await this.videoPool.playStandbyUntilReady();
      this.videoPool.commitStandby();
      await this.reportSwitchCommitted(snapshot, transition.switchTarget);
      return {
        status: "committed",
        switchTarget: transition.switchTarget
      };
    } catch (error) {
      this.videoPool.rollback();
      await this.reportSwitchFailure(snapshot, transition.switchTarget, error);
      return {
        status: "reverted",
        switchTarget: transition.switchTarget,
        message: "Switch failed and playback returned to the previous version."
      };
    }
  }

  private async commitAudioTrackSwitch(snapshot: RoomSnapshot, switchTarget: SwitchTarget): Promise<SwitchRuntimeResult> {
    const previousPositionMs = Math.max(0, Math.trunc(this.videoPool.activeVideo.currentTime * 1000));
    const result = selectAudioTrack(this.videoPool.activeVideo, switchTarget.selectedTrackRef);
    if (result.status !== "selected") {
      // Chromium 系浏览器没有 video.audioTracks,单文件切轨选不出音轨;若服务端给了
      // remux 选轨流地址,改用 standby 视频池整流切换(视频相同、音轨即目标轨)。
      if (switchTarget.fallbackPlaybackUrl) {
        const fallbackResult = await this.commitFallbackStreamSwitch(snapshot, switchTarget);
        if (fallbackResult.status === "committed") {
          return fallbackResult;
        }
      }
      await this.reportSwitchFailure(snapshot, switchTarget, new Error(result.message), "audio_track", previousPositionMs);
      return {
        status: "reverted",
        switchTarget,
        message: revertedMessageForAudioTrackSelection(result)
      };
    }

    this.videoPool.commitActiveAudioTrackSwitch(switchTarget);
    await this.reportSwitchCommitted(snapshot, switchTarget);
    return {
      status: "committed",
      switchTarget
    };
  }

  private async commitFallbackStreamSwitch(snapshot: RoomSnapshot, switchTarget: SwitchTarget): Promise<SwitchRuntimeResult> {
    // remux 流从 startMs 开始输出;提交前用当前真实进度再校准一次 start,
    // 并把该进度记为流的位置基准(standby currentTime 从 0 起)。
    const positionMs = this.videoPool.activePlaybackPositionMs();
    const fallbackUrl = withStartPosition(switchTarget.fallbackPlaybackUrl ?? switchTarget.playbackUrl, positionMs);
    // -c copy 的 remux 流里视频回退到 start 前最近 keyframe 再整体平移到 0,
    // 音频在流内 (start - keyframe) 处才开始;先探测该提前量并从位置基准扣除,
    // 否则 positionBaseMs + currentTime 会超前真实进度(歌词高亮错位)。
    // 探测失败按 0 处理,维持现状行为。
    const startOffsetMs = (await this.startOffsetProbe(withOffsetProbeParam(fallbackUrl)).catch(() => null)) ?? 0;
    const fallbackTarget: SwitchTarget = {
      ...switchTarget,
      playbackUrl: fallbackUrl,
      resumePositionMs: 0
    };

    try {
      this.videoPool.prepareStandby(fallbackTarget, { positionBaseMs: Math.max(0, positionMs - startOffsetMs) });
      await this.videoPool.playStandbyUntilReady();
      this.videoPool.commitStandby();
      await this.reportSwitchCommitted(snapshot, switchTarget);
      return {
        status: "committed",
        switchTarget
      };
    } catch (error) {
      this.videoPool.rollback();
      await this.reportSwitchFailure(snapshot, switchTarget, error, "fallback_stream");
      return {
        status: "reverted",
        switchTarget,
        message: "切换失败,已保持当前播放。"
      };
    }
  }

  private async reportSwitchFailure(
    snapshot: RoomSnapshot,
    switchTarget: SwitchTarget,
    error: unknown,
    stage = "standby",
    playbackPositionMs = switchTarget.resumePositionMs
  ): Promise<void> {
    await this.client.sendTelemetry({
      roomSlug: snapshot.roomSlug,
      deviceId: this.deviceId,
      eventType: "switch_failed",
      sessionVersion: switchTarget.sessionVersion,
      queueEntryId: switchTarget.queueEntryId,
      sourceType: switchTarget.sourceType,
      assetId: switchTarget.toAssetId,
      playbackPositionMs,
      vocalMode: snapshot.currentTarget?.vocalMode ?? switchTarget.vocalMode,
      switchFamily: switchTarget.switchFamily,
      rollbackAssetId: switchTarget.rollbackAssetId,
      message: error instanceof Error ? error.message : "standby playback failed",
      stage
    });
  }

  private async reportSwitchCommitted(snapshot: RoomSnapshot, switchTarget: SwitchTarget): Promise<void> {
    await this.client.sendTelemetry({
      roomSlug: snapshot.roomSlug,
      deviceId: this.deviceId,
      eventType: "playing",
      sessionVersion: switchTarget.sessionVersion,
      queueEntryId: switchTarget.queueEntryId,
      sourceType: switchTarget.sourceType,
      assetId: switchTarget.toAssetId,
      playbackPositionMs: this.videoPool.activePlaybackPositionMs(),
      vocalMode: switchTarget.vocalMode,
      switchFamily: switchTarget.switchFamily,
      rollbackAssetId: switchTarget.rollbackAssetId,
      stage: "switch_committed"
    });
  }
}

function withStartPosition(url: string, startMs: number): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("start", String(Math.max(0, Math.trunc(startMs))));
    return parsed.toString();
  } catch {
    return url;
  }
}

const startOffsetProbeTimeoutMs = 2000;
const remuxStartOffsetHeaderName = "x-ktv-start-offset-ms";

// 向 remux 路由询问 "-c copy 回退 keyframe" 造成的流起点提前量(ms):
// 探测 URL 已带 offsetProbe=1;响应头优先,缺失时读 JSON body 的 startOffsetMs。
// 任何失败(网络/超时/字段异常)都返回 null,切换流程按无提前量继续,绝不阻断兜底切换。
async function probeRemuxStartOffsetMs(probeUrl: string): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), startOffsetProbeTimeoutMs);
  try {
    const response = await fetch(probeUrl, {
      signal: controller.signal,
      cache: "no-store"
    });
    if (!response.ok) {
      return null;
    }

    const headerOffsetMs = Number(response.headers.get(remuxStartOffsetHeaderName));
    if (Number.isFinite(headerOffsetMs) && headerOffsetMs > 0) {
      return Math.trunc(headerOffsetMs);
    }

    const payload = (await response.json().catch(() => null)) as { startOffsetMs?: unknown } | null;
    const bodyOffsetMs = payload?.startOffsetMs;
    return typeof bodyOffsetMs === "number" && Number.isFinite(bodyOffsetMs) && bodyOffsetMs > 0
      ? Math.trunc(bodyOffsetMs)
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function withOffsetProbeParam(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}offsetProbe=1`;
}

function revertedMessageForAudioTrackSelection(result: Exclude<AudioTrackSelectionResult, { status: "selected" }>): string {
  return result.status === "missing_track"
    ? "未找到请求的音轨，已保持当前播放。"
    : "当前电视浏览器不支持切换原唱/伴唱，已保持当前播放。";
}

export function canAttemptRuntimePlayback(snapshot: RoomSnapshot | null): boolean {
  return Boolean(snapshot?.currentTarget);
}
