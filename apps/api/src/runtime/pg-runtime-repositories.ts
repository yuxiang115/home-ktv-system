import type { QueryExecutor } from "../db/query-executor.js";
import { PgAssetRepository, type AssetRepository } from "../modules/catalog/repositories/asset-repository.js";
import {
  PgSongRepository,
  type AdminCatalogSongRepository,
  type SongRepository
} from "../modules/catalog/repositories/song-repository.js";
import {
  PgControlSessionRepository,
  type ControlSessionRepository
} from "../modules/controller/repositories/control-session-repository.js";
import { PgKtvIndexReadRepository, type KtvIndexReadRepository } from "../modules/ktv-index/ktv-index-read-repository.js";
import { PgPlayerDeviceSessionRepository } from "../modules/player/register-player.js";
import { PgPlaybackEventRepository } from "../modules/playback/repositories/playback-event-repository.js";
import { PgPlaybackSessionRepository } from "../modules/playback/repositories/playback-session-repository.js";
import { PgQueueEntryRepository } from "../modules/playback/repositories/queue-entry-repository.js";
import {
  PgRoomSessionCommandRepository,
  type RoomSessionCommandRepository
} from "../modules/playback/repositories/room-session-command-repository.js";
import { PgRoomPairingTokenRepository } from "../modules/rooms/repositories/pairing-token-repository.js";
import { PgRoomRepository } from "../modules/rooms/repositories/room-repository.js";
import type { PlayerRouteRepositories } from "../routes/player.js";

export type RuntimeRepositories = PlayerRouteRepositories & {
  songs: SongRepository & AdminCatalogSongRepository;
  assets: AssetRepository;
  controlSessions: ControlSessionRepository;
  controlCommands: RoomSessionCommandRepository;
  ktvIndex?: KtvIndexReadRepository;
};

export function createPgRuntimeRepositories(db: QueryExecutor): RuntimeRepositories {
  const playbackSessions = new PgPlaybackSessionRepository(db);

  return {
    rooms: new PgRoomRepository(db),
    playbackSessions,
    queueEntries: new PgQueueEntryRepository(db),
    assets: new PgAssetRepository(db),
    songs: new PgSongRepository(db),
    pairingTokens: new PgRoomPairingTokenRepository(db),
    controlSessions: new PgControlSessionRepository(db),
    controlCommands: new PgRoomSessionCommandRepository(db),
    deviceSessions: new PgPlayerDeviceSessionRepository(db),
    playbackEvents: new PgPlaybackEventRepository(db),
    ktvIndex: new PgKtvIndexReadRepository(db)
  };
}
