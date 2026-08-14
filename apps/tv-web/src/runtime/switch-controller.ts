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
}

export class SwitchController {
  private readonly client: SwitchRuntimeClient;
  private readonly deviceId: string;
  private readonly videoPool: DualVideoPool;

  constructor(input: SwitchControllerInput) {
    this.client = input.client;
    this.videoPool = input.videoPool;
    this.deviceId = input.deviceId ?? "tv-player";
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
    const fallbackTarget: SwitchTarget = {
      ...switchTarget,
      playbackUrl: fallbackUrl,
      resumePositionMs: 0
    };

    try {
      this.videoPool.prepareStandby(fallbackTarget, { positionBaseMs: positionMs });
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

function revertedMessageForAudioTrackSelection(result: Exclude<AudioTrackSelectionResult, { status: "selected" }>): string {
  return result.status === "missing_track"
    ? "未找到请求的音轨，已保持当前播放。"
    : "当前电视浏览器不支持切换原唱/伴唱，已保持当前播放。";
}

export function canAttemptRuntimePlayback(snapshot: RoomSnapshot | null): boolean {
  return Boolean(snapshot?.currentTarget);
}
