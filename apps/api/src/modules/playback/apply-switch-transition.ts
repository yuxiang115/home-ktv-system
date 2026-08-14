import type { SwitchTransitionResult } from "@home-ktv/player-contracts";
import type { MediaGateway } from "../media/media-gateway.js";
import { buildSwitchTarget, type BuildSwitchTargetRepositories } from "./build-switch-target.js";

export interface ApplySwitchTransitionInput {
  roomSlug: string;
  playbackPositionMs?: number | undefined;
  repositories: BuildSwitchTargetRepositories;
  mediaGateway?: Pick<MediaGateway, "createPlaybackUrl">;
}

export async function applySwitchTransition(input: ApplySwitchTransitionInput): Promise<SwitchTransitionResult> {
  const switchTarget = await buildSwitchTarget({
    roomSlug: input.roomSlug,
    repositories: input.repositories,
    ...(input.mediaGateway ? { mediaGateway: input.mediaGateway } : {})
  });

  if (!switchTarget) {
    return {
      status: "unavailable",
      switchTarget: null,
      reason: "SWITCH_TARGET_NOT_AVAILABLE"
    };
  }

  const clientPositionMs =
    typeof input.playbackPositionMs === "number" && Number.isFinite(input.playbackPositionMs)
      ? Math.max(0, Math.trunc(input.playbackPositionMs))
      : null;

  return {
    status: "ready",
    switchTarget: {
      ...switchTarget,
      resumePositionMs: clientPositionMs ?? switchTarget.resumePositionMs,
      // remux 兜底流里的 start 参数在建 target 时用的是 session 位置(可能陈旧,
      // 手机发起切换时甚至是 0);用 TV 上报的精确位置重写,否则切换会从头重播。
      ...(switchTarget.fallbackPlaybackUrl && clientPositionMs !== null
        ? { fallbackPlaybackUrl: withRemuxStartPosition(switchTarget.fallbackPlaybackUrl, clientPositionMs) }
        : {})
    },
    reason: null
  };
}

export function withRemuxStartPosition(url: string, startMs: number): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("start", String(Math.max(0, Math.trunc(startMs))));
    return parsed.toString();
  } catch {
    return url;
  }
}
