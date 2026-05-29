import type { PlaybackEvent, PlaybackEventId, QueueEntryId, RoomId } from "@home-ktv/domain";

export interface CreatePlaybackEventInput<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  roomId: RoomId;
  queueEntryId: QueueEntryId | null;
  eventType: string;
  eventPayload: TPayload;
}

export interface PlaybackEventRepository {
  append<TPayload extends Record<string, unknown>>(input: CreatePlaybackEventInput<TPayload>): Promise<PlaybackEvent<TPayload>>;
  listRecentByRoom?(roomId: RoomId, limit?: number): Promise<PlaybackEvent[]>;
}

export class InMemoryPlaybackEventRepository implements PlaybackEventRepository {
  private readonly events: PlaybackEvent[] = [];

  async append<TPayload extends Record<string, unknown>>(
    input: CreatePlaybackEventInput<TPayload>
  ): Promise<PlaybackEvent<TPayload>> {
    const event: PlaybackEvent<TPayload> = {
      id: `event-${this.events.length + 1}` as PlaybackEventId,
      roomId: input.roomId,
      queueEntryId: input.queueEntryId,
      eventType: input.eventType,
      eventPayload: { ...input.eventPayload },
      createdAt: new Date().toISOString()
    };
    this.events.unshift(event);
    if (this.events.length > 100) {
      this.events.length = 100;
    }
    return clonePlaybackEvent(event);
  }

  async listRecentByRoom(roomId: RoomId, limit = 20): Promise<PlaybackEvent[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    return this.events
      .filter((event) => event.roomId === roomId)
      .slice(0, boundedLimit)
      .map(clonePlaybackEvent);
  }
}

function clonePlaybackEvent<TPayload extends Record<string, unknown>>(event: PlaybackEvent<TPayload>): PlaybackEvent<TPayload> {
  return {
    ...event,
    eventPayload: { ...event.eventPayload }
  };
}
