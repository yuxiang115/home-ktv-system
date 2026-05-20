import type { FastifyInstance } from "fastify";
import type { SongSearchResponse } from "@home-ktv/domain";
import type { QueryExecutor } from "../db/query-executor.js";
import type { AdminCatalogSongRepository } from "../modules/catalog/repositories/song-repository.js";
import type { KtvIndexReadRepository } from "../modules/ktv-index/ktv-index-read-repository.js";
import type { CandidateTaskService } from "../modules/online/candidate-task-service.js";
import type { QueueEntryRepository } from "../modules/playback/repositories/queue-entry-repository.js";
import type { RoomRepository } from "../modules/rooms/repositories/room-repository.js";

export interface SongSearchRouteDependencies {
  rooms: RoomRepository;
  songs: AdminCatalogSongRepository;
  queueEntries: QueueEntryRepository;
  online?: Pick<CandidateTaskService, "discoverCandidates">;
  ktvIndex?: Pick<KtvIndexReadRepository, "searchIndexedSongs">;
  indexedSources?: IndexedSourceIdentityLookup;
}

export interface IndexedSourceIdentityLookup {
  findIndexedAssetIdsForCanonicalAssets(assetIds: readonly string[]): Promise<string[]>;
}

export class PgIndexedSourceIdentityLookup implements IndexedSourceIdentityLookup {
  constructor(private readonly db: QueryExecutor) {}

  async findIndexedAssetIdsForCanonicalAssets(assetIds: readonly string[]): Promise<string[]> {
    if (assetIds.length === 0) {
      return [];
    }

    const result = await this.db.query<{ provider_item_id: string | null }>(
      `SELECT provider_item_id
       FROM source_records
       WHERE provider = 'ktv-index'
         AND provider_item_id IS NOT NULL
         AND asset_id = ANY($1::text[])`,
      [assetIds]
    );

    return result.rows.map((row) => row.provider_item_id).filter((id): id is string => typeof id === "string");
  }
}

interface SongSearchQuery {
  q?: string;
  limit?: string | number;
}

export async function registerSongSearchRoutes(
  server: FastifyInstance,
  dependencies: SongSearchRouteDependencies
): Promise<void> {
  server.get<{ Params: { roomSlug: string }; Querystring: SongSearchQuery }>(
    "/rooms/:roomSlug/songs/search",
    async (request, reply) => {
      const room = await dependencies.rooms.findBySlug(request.params.roomSlug);
      if (!room) {
        await reply.code(404).send({ code: "ROOM_NOT_FOUND" });
        return;
      }

      const query = String(request.query.q ?? "");
      const rawLimit = request.query.limit;
      const parsedLimit =
        typeof rawLimit === "number" ? Math.trunc(rawLimit) : Number.parseInt(String(rawLimit ?? ""), 10);
      const limit = Math.min(50, Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : 30));
      const queue = await dependencies.queueEntries.listEffectiveQueue(room.id);
      const queuedSongIds = queue.map((entry) => entry.songId);
      const queuedAssetIds = queue.map((entry) => entry.assetId);
      const queuedIndexedAssetIds =
        (await dependencies.indexedSources?.findIndexedAssetIdsForCanonicalAssets(queuedAssetIds)) ?? [];
      const records = await dependencies.songs.searchFormalSongs({ query, limit, queuedSongIds });
      const indexedResults =
        (await dependencies.ktvIndex?.searchIndexedSongs({
          query,
          limit: Math.min(20, limit),
          versionsPerSong: 4,
          queuedIndexedAssetIds,
          unreadableIndexedAssetIds: []
        })) ?? [];
      const onlineCandidates =
        (await dependencies.online?.discoverCandidates({
          roomId: room.id,
          query,
          limit: 10
        })) ?? [];

      const response: SongSearchResponse = {
        query,
        local: records.map((record) => ({
          songId: record.song.id,
          title: record.song.title,
          artistName: record.song.artistName,
          language: record.song.language,
          matchReason: record.matchReason,
          queueState: record.queueState,
          versions: record.versions
        })),
        indexed: {
          status: indexedResults.length > 0 ? "available" : "unavailable",
          message: indexedResults.length > 0 ? "找到 KTV 索引结果" : "未找到 KTV 索引结果",
          results: indexedResults
        },
        online: {
          status: onlineCandidates.length > 0 ? "available" : "disabled",
          message: onlineCandidates.length > 0 ? "找到在线补歌候选" : "本地未入库，补歌功能后续可用",
          requestSupplement: {
            visible: records.length === 0,
            label: "请求补歌"
          },
          candidates: onlineCandidates
        }
      };

      await reply.send(response);
    }
  );
}
