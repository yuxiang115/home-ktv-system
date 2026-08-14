import type { RoomSnapshot } from "@home-ktv/player-contracts";
import type { DualVideoPool } from "./video-pool.js";

export interface HeartbeatRuntimeClient {
  sendHeartbeat(input: {
    currentQueueEntryId: string | null;
    playbackPositionMs: number;
    health?: "ok" | "degraded" | "blocked";
  }): Promise<void>;
}

export type HeartbeatResult = { status: "sent" };

export interface HeartbeatControllerInput {
  client: HeartbeatRuntimeClient;
  videoPool: DualVideoPool;
}

export class HeartbeatController {
  private readonly client: HeartbeatRuntimeClient;
  private readonly videoPool: DualVideoPool;

  constructor(input: HeartbeatControllerInput) {
    this.client = input.client;
    this.videoPool = input.videoPool;
  }

  async send(snapshot: RoomSnapshot): Promise<HeartbeatResult> {
    const target = this.videoPool.activeTarget ?? snapshot.currentTarget;

    await this.client.sendHeartbeat({
      currentQueueEntryId: target?.queueEntryId ?? null,
      playbackPositionMs: target ? this.videoPool.activePlaybackPositionMs() : 0,
      health: "ok"
    });

    return { status: "sent" };
  }
}
