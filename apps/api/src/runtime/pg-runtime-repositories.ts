import type { QueryExecutor } from "../db/query-executor.js";
import { PgSongCoverCacheRepository, type SongCoverCacheRepository } from "../modules/covers/song-cover-cache-repository.js";
import type { MediaPathMapping } from "../modules/assets/media-path-mapping.js";
import {
  PgControlSessionRepository,
  type ControlSessionRepository
} from "../modules/controller/repositories/control-session-repository.js";
import { PgKtvIndexReadRepository, type KtvIndexReadRepository } from "../modules/ktv-index/ktv-index-read-repository.js";
import { NasPlayableMediaRepository } from "../modules/media/nas-playable-media-repository.js";
import type { PlayableMediaRepository } from "../modules/media/playable-media-repository.js";
import { PgPlayerDeviceSessionRepository } from "../modules/player/register-player.js";
import { InMemoryPlaybackEventRepository } from "../modules/playback/repositories/playback-event-repository.js";
import { PgPlaybackSessionRepository } from "../modules/playback/repositories/playback-session-repository.js";
import { PgQueueEntryRepository } from "../modules/playback/repositories/queue-entry-repository.js";
import {
  InMemoryRoomSessionCommandRepository,
  type RoomSessionCommandRepository
} from "../modules/playback/repositories/room-session-command-repository.js";
import { PgRoomPairingTokenRepository } from "../modules/rooms/repositories/pairing-token-repository.js";
import { PgRoomRepository } from "../modules/rooms/repositories/room-repository.js";
import type { PlayerRouteRepositories } from "../routes/player.js";

export type RuntimeRepositories = PlayerRouteRepositories & {
  controlSessions: ControlSessionRepository;
  controlCommands: RoomSessionCommandRepository;
  songCovers?: SongCoverCacheRepository;
  ktvIndex?: KtvIndexReadRepository;
  playableMedia?: PlayableMediaRepository;
};

export interface CreatePgRuntimeRepositoriesOptions {
  mediaPathMappings?: readonly MediaPathMapping[];
}

export function createPgRuntimeRepositories(
  db: QueryExecutor,
  options: CreatePgRuntimeRepositoriesOptions = {}
): RuntimeRepositories {
  const playbackSessions = new PgPlaybackSessionRepository(db);

  return {
    rooms: new PgRoomRepository(db),
    playbackSessions,
    playableMedia: new NasPlayableMediaRepository(db),
    queueEntries: new PgQueueEntryRepository(db),
    songCovers: new PgSongCoverCacheRepository(db),
    pairingTokens: new PgRoomPairingTokenRepository(db),
    controlSessions: new PgControlSessionRepository(db),
    controlCommands: new InMemoryRoomSessionCommandRepository(),
    deviceSessions: new PgPlayerDeviceSessionRepository(db),
    playbackEvents: new InMemoryPlaybackEventRepository(),
    ktvIndex: new PgKtvIndexReadRepository(db, {
      ...(options.mediaPathMappings ? { pathMappings: options.mediaPathMappings } : {})
    })
  };
}
