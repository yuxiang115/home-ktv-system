import type {
  ControlCommandResultStatus,
  ControlCommandType,
  ControlSessionId,
  RoomId
} from "@home-ktv/domain";

export interface RoomSessionCommandRecord {
  commandId: string;
  roomId: RoomId;
  controlSessionId: ControlSessionId;
  sessionVersion: number;
  type: ControlCommandType;
  payload: Record<string, unknown>;
  resultStatus: ControlCommandResultStatus;
  resultPayload: Record<string, unknown>;
  createdAt: string;
}

export interface InsertCommandAttemptInput {
  commandId: string;
  roomId: RoomId;
  controlSessionId: ControlSessionId;
  sessionVersion: number;
  type: ControlCommandType;
  payload: Record<string, unknown>;
  resultStatus: ControlCommandResultStatus;
  resultPayload?: Record<string, unknown>;
}

export interface UpdateCommandResultInput {
  commandId: string;
  resultStatus: ControlCommandResultStatus;
  resultPayload?: Record<string, unknown>;
}

export interface RoomSessionCommandRepository {
  findCommand(commandId: string): Promise<RoomSessionCommandRecord | null>;
  insertCommandAttempt(input: InsertCommandAttemptInput): Promise<RoomSessionCommandRecord>;
  updateCommandResult(input: UpdateCommandResultInput): Promise<RoomSessionCommandRecord | null>;
}

export class InMemoryRoomSessionCommandRepository implements RoomSessionCommandRepository {
  private readonly records = new Map<string, RoomSessionCommandRecord>();

  async findCommand(commandId: string): Promise<RoomSessionCommandRecord | null> {
    const record = this.records.get(commandId);
    return record ? cloneRoomSessionCommandRecord(record) : null;
  }

  async insertCommandAttempt(input: InsertCommandAttemptInput): Promise<RoomSessionCommandRecord> {
    const record: RoomSessionCommandRecord = {
      commandId: input.commandId,
      roomId: input.roomId,
      controlSessionId: input.controlSessionId,
      sessionVersion: input.sessionVersion,
      type: input.type,
      payload: { ...input.payload },
      resultStatus: input.resultStatus,
      resultPayload: { ...(input.resultPayload ?? {}) },
      createdAt: new Date().toISOString()
    };
    this.records.set(record.commandId, record);
    return cloneRoomSessionCommandRecord(record);
  }

  async updateCommandResult(input: UpdateCommandResultInput): Promise<RoomSessionCommandRecord | null> {
    const existing = this.records.get(input.commandId);
    if (!existing) {
      return null;
    }

    const updated: RoomSessionCommandRecord = {
      ...existing,
      resultStatus: input.resultStatus,
      resultPayload: { ...(input.resultPayload ?? {}) }
    };
    this.records.set(input.commandId, updated);
    return cloneRoomSessionCommandRecord(updated);
  }
}

function cloneRoomSessionCommandRecord(record: RoomSessionCommandRecord): RoomSessionCommandRecord {
  return {
    ...record,
    payload: { ...record.payload },
    resultPayload: { ...record.resultPayload }
  };
}
