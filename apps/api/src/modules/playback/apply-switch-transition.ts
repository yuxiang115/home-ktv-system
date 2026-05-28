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

  return {
    status: "ready",
    switchTarget: {
      ...switchTarget,
      resumePositionMs:
        typeof input.playbackPositionMs === "number" && Number.isFinite(input.playbackPositionMs)
          ? Math.max(0, Math.trunc(input.playbackPositionMs))
          : switchTarget.resumePositionMs
    },
    reason: null
  };
}
