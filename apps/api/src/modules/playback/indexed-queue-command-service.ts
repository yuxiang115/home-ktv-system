import type { Pool } from "pg";
import type { Room } from "@home-ktv/domain";
import type { ControlSessionInfo } from "@home-ktv/player-contracts";
import { SESSION_VERSION_CONFLICT } from "@home-ktv/session-engine";
import type { ApiConfig } from "../../config.js";
import type { QueryExecutor } from "../../db/query-executor.js";
import type { AssetGateway } from "../assets/asset-gateway.js";
import {
  KtvCatalogSyncError,
  PgKtvCatalogSyncService,
  type PgKtvCatalogSyncServiceOptions
} from "../catalog/ktv-catalog-sync-service.js";
import {
  type PreparedKtvIndexedMedia,
  type PrepareKtvIndexedMediaInput
} from "../catalog/ktv-index-media-preprocessor.js";
import { restoreControlSession } from "../controller/control-session-service.js";
import {
  executeRoomCommand,
  type CommandExecutionResult
} from "./session-command-service.js";
import { buildRoomControlSnapshot } from "../rooms/build-control-snapshot.js";
import {
  createPgRuntimeRepositories,
  type RuntimeRepositories
} from "../../runtime/pg-runtime-repositories.js";

export interface ExecuteIndexedAddQueueEntryInput {
  commandId: string;
  roomSlug: string;
  sessionVersion: number;
  deviceId: string;
  indexedAssetId: string;
  cookieHeader: string | undefined;
}

export class PgIndexedQueueCommandService {
  private readonly createRepositories: (db: QueryExecutor) => RuntimeRepositories;

  constructor(
    private readonly options: {
      pool: Pick<Pool, "connect">;
      config: ApiConfig;
      assetGateway: AssetGateway;
      createRepositories?: (db: QueryExecutor) => RuntimeRepositories;
      prepareKtvIndexedMedia?: (input: PrepareKtvIndexedMediaInput) => Promise<PreparedKtvIndexedMedia>;
    }
  ) {
    this.createRepositories = options.createRepositories ?? createPgRuntimeRepositories;
  }

  async executeIndexedAddQueueEntry(input: ExecuteIndexedAddQueueEntryInput): Promise<CommandExecutionResult> {
    const client = await this.options.pool.connect();

    try {
      await client.query("BEGIN");
      const repositories = this.createRepositories(client);
      const room = await repositories.rooms.findBySlug(input.roomSlug);
      if (!room) {
        await client.query("ROLLBACK");
        return rejected(input, "ROOM_NOT_FOUND");
      }

      const controlSession = await restoreControlSession({
        room,
        cookieHeader: input.cookieHeader,
        deviceId: input.deviceId,
        controlSessions: repositories.controlSessions
      });
      if (!controlSession) {
        await client.query("ROLLBACK");
        return rejected(input, "CONTROL_SESSION_REQUIRED");
      }

      const preflightResult = await this.preflightCommand({
        input,
        repositories,
        room,
        controlSession
      });
      if (preflightResult) {
        await client.query("COMMIT");
        return preflightResult;
      }

      const syncOptions: PgKtvCatalogSyncServiceOptions = {
        pathMappings: this.options.config.mediaPathMappings
      };
      const prepareKtvIndexedMedia = this.options.prepareKtvIndexedMedia;
      if (prepareKtvIndexedMedia) {
        syncOptions.prepareMedia = (mediaInput) =>
          prepareKtvIndexedMedia({
            ...mediaInput,
            mediaRoot: this.options.config.mediaRoot
          });
      }

      const sync = await new PgKtvCatalogSyncService(client, syncOptions).syncIndexedAsset({
        indexedAssetId: input.indexedAssetId
      });
      const result = await executeRoomCommand({
        commandId: input.commandId,
        roomSlug: input.roomSlug,
        sessionVersion: input.sessionVersion,
        type: "add-queue-entry",
        payload: {
          songId: sync.songId,
          assetId: sync.assetId,
          queueAdmissionSource: "ktv-index",
          indexedAssetId: input.indexedAssetId
        },
        controlSession,
        repositories,
        assetGateway: this.options.assetGateway,
        config: this.options.config
      });

      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof KtvCatalogSyncError) {
        return rejected(input, error.code, error.message);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async preflightCommand(input: {
    input: ExecuteIndexedAddQueueEntryInput;
    repositories: RuntimeRepositories;
    room: Room;
    controlSession: ControlSessionInfo;
  }): Promise<CommandExecutionResult | null> {
    const { repositories, room } = input;
    const commandInput = input.input;

    if (!commandInput.commandId.trim()) {
      return rejected(commandInput, "INVALID_COMMAND_ID");
    }

    const existing = await repositories.controlCommands.findCommand(commandInput.commandId);
    if (existing) {
      return {
        status: "duplicate",
        commandId: commandInput.commandId,
        sessionVersion: existing.sessionVersion
      };
    }

    const session = await repositories.playbackSessions.findByRoomId(room.id);
    if (!session) {
      return rejected(commandInput, "PLAYBACK_SESSION_NOT_FOUND");
    }

    if (session.version === commandInput.sessionVersion) {
      return null;
    }

    const snapshot = await buildRoomControlSnapshot({
      roomSlug: room.slug,
      config: this.options.config,
      repositories,
      assetGateway: this.options.assetGateway
    });
    if (!snapshot) {
      return rejected(commandInput, "ROOM_NOT_FOUND");
    }

    await repositories.controlCommands.insertCommandAttempt({
      commandId: commandInput.commandId,
      roomId: room.id,
      controlSessionId: input.controlSession.id,
      sessionVersion: commandInput.sessionVersion,
      type: "add-queue-entry",
      payload: {
        queueAdmissionSource: "ktv-index",
        indexedAssetId: commandInput.indexedAssetId
      },
      resultStatus: "conflict",
      resultPayload: {
        code: SESSION_VERSION_CONFLICT,
        latestSessionVersion: snapshot.sessionVersion,
        snapshot
      }
    });

    return {
      status: "conflict",
      commandId: commandInput.commandId,
      code: SESSION_VERSION_CONFLICT,
      latestSessionVersion: snapshot.sessionVersion,
      snapshot
    };
  }
}

function rejected(
  input: Pick<ExecuteIndexedAddQueueEntryInput, "commandId" | "sessionVersion">,
  code: string,
  message?: string
): CommandExecutionResult {
  return {
    status: "rejected",
    commandId: input.commandId,
    sessionVersion: input.sessionVersion,
    code,
    ...(message ? { message } : {})
  };
}
