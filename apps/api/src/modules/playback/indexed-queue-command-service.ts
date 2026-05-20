import type { Pool } from "pg";
import type { ApiConfig } from "../../config.js";
import type { QueryExecutor } from "../../db/query-executor.js";
import type { AssetGateway } from "../assets/asset-gateway.js";
import {
  KtvCatalogSyncError,
  PgKtvCatalogSyncService
} from "../catalog/ktv-catalog-sync-service.js";
import {
  prepareKtvIndexedMediaForWeb,
  type PreparedKtvIndexedMedia,
  type PrepareKtvIndexedMediaInput
} from "../catalog/ktv-index-media-preprocessor.js";
import { restoreControlSession } from "../controller/control-session-service.js";
import {
  executeRoomCommand,
  type CommandExecutionResult
} from "./session-command-service.js";
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

      const sync = await new PgKtvCatalogSyncService(client, {
        pathMappings: this.options.config.mediaPathMappings,
        prepareMedia: (mediaInput) =>
          (this.options.prepareKtvIndexedMedia ?? prepareKtvIndexedMediaForWeb)({
            ...mediaInput,
            mediaRoot: this.options.config.mediaRoot
          })
      }).syncIndexedAsset({
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
