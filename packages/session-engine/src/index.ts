import type {
  ControlCommandType,
  PlaybackEvent,
  PlaybackSession,
  QueueEntry,
  QueueEntryStatus
} from "@home-ktv/domain";
import type { PlaybackTarget, PlayerTelemetryEvent, SwitchTarget } from "@home-ktv/player-contracts";

export type RoomSessionCommandType = ControlCommandType;

export interface RoomSessionCommand {
  commandId: string;
  roomId: string;
  controlSessionId: string;
  sessionVersion: number;
  type: RoomSessionCommandType;
  payload: Record<string, unknown>;
}

export interface RoomSessionCommandResult {
  status: "accepted" | "duplicate" | "conflict" | "rejected";
  sessionVersion: number;
  code?: string;
  message?: string;
}

export const SESSION_VERSION_CONFLICT = "SESSION_VERSION_CONFLICT" as const;

export interface SessionEngineState {
  session: PlaybackSession;
  queue: readonly QueueEntry[];
  events: readonly PlaybackEvent[];
}

export type SessionEngineCommand =
  | { type: "apply-playback-target"; target: PlaybackTarget }
  | { type: "apply-switch-target"; target: SwitchTarget }
  | { type: "record-player-telemetry"; event: PlayerTelemetryEvent };

export interface SessionCommandHandlers {
  reduce: (state: SessionEngineState, command: SessionEngineCommand) => SessionEngineState;
  handleTelemetry: (state: SessionEngineState, event: PlayerTelemetryEvent) => SessionEngineState;
}

export function effectiveQueue(queue: readonly QueueEntry[]): QueueEntry[] {
  return queue.filter((entry) => isEffectiveQueueStatus(entry.status));
}

export function promoteAfterCurrent(
  queue: readonly QueueEntry[],
  queueEntryId: string,
  currentQueueEntryId: string
): QueueEntry[] {
  const targetIndex = queue.findIndex((entry) => entry.id === queueEntryId);
  const currentIndex = queue.findIndex((entry) => entry.id === currentQueueEntryId);
  if (targetIndex < 0 || currentIndex < 0 || targetIndex === currentIndex) {
    return [...queue];
  }

  const target = queue[targetIndex];
  if (!target) {
    return [...queue];
  }
  if (!isPromotableQueueStatus(target.status)) {
    return [...queue];
  }

  const reordered = [...queue];
  reordered.splice(targetIndex, 1);

  const currentIndexAfterRemoval = reordered.findIndex((entry) => entry.id === currentQueueEntryId);
  if (currentIndexAfterRemoval < 0) {
    return [...queue];
  }

  reordered.splice(currentIndexAfterRemoval + 1, 0, target);
  return reordered;
}

export function interleaveQueueByRequester(
  queue: readonly QueueEntry[],
  currentQueueEntryId: string | null = null
): QueueEntry[] {
  const currentIndex = currentQueueEntryId
    ? queue.findIndex((entry) => entry.id === currentQueueEntryId)
    : queue.findIndex((entry) => entry.status === "playing");
  const prefix = currentIndex >= 0 ? queue.slice(0, currentIndex + 1) : [];
  const candidates = currentIndex >= 0 ? queue.slice(currentIndex + 1) : [...queue];
  const groups = new Map<string, QueueEntry[]>();
  const groupOrder: string[] = [];
  const locked: QueueEntry[] = [];

  for (const entry of candidates) {
    if (!isPromotableQueueStatus(entry.status)) {
      locked.push(entry);
      continue;
    }

    const requesterKey = requesterIdentity(entry);
    if (!groups.has(requesterKey)) {
      groups.set(requesterKey, []);
      groupOrder.push(requesterKey);
    }
    groups.get(requesterKey)?.push(entry);
  }

  const interleaved: QueueEntry[] = [];
  let hasRemaining = true;
  while (hasRemaining) {
    hasRemaining = false;
    for (const requesterKey of groupOrder) {
      const group = groups.get(requesterKey);
      const next = group?.shift();
      if (!next) {
        continue;
      }
      interleaved.push(next);
      hasRemaining = true;
    }
  }

  return [...prefix, ...interleaved, ...locked];
}

export function reduceSessionEngine(state: SessionEngineState, _command: SessionEngineCommand): SessionEngineState {
  return state;
}

export function createSessionCommandHandlers(): SessionCommandHandlers {
  return {
    reduce: reduceSessionEngine,
    handleTelemetry: (state) => state
  };
}

function isEffectiveQueueStatus(status: QueueEntryStatus): boolean {
  return status === "queued" || status === "preparing" || status === "loading" || status === "playing";
}

function isPromotableQueueStatus(status: QueueEntryStatus): boolean {
  return status === "queued" || status === "preparing" || status === "loading";
}

function requesterIdentity(entry: QueueEntry): string {
  return entry.requestedByUserPhone?.trim() || entry.requestedByName?.trim() || entry.requestedBy.trim() || "unknown";
}
