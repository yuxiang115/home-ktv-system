import type { FastifyInstance } from "fastify";
import type {
  SongDiscoveryArtist,
  SongDiscoveryGenre,
  SongDiscoveryResponse,
  SongDiscoverySong,
  SongId,
  SongSearchIndexedResult
} from "@home-ktv/domain";
import type { AdminCatalogSongRepository, SearchFormalSongRecord } from "../modules/catalog/repositories/song-repository.js";
import type { KtvIndexReadRepository } from "../modules/ktv-index/ktv-index-read-repository.js";
import type { QueueEntryRepository } from "../modules/playback/repositories/queue-entry-repository.js";
import type { RoomRepository } from "../modules/rooms/repositories/room-repository.js";

export interface SongDiscoveryRouteDependencies {
  rooms: RoomRepository;
  songs: AdminCatalogSongRepository;
  queueEntries: QueueEntryRepository;
  ktvIndex?: Pick<KtvIndexReadRepository, "searchIndexedSongs">;
  indexedSources?: IndexedSourceIdentityLookup;
}

export interface IndexedSourceIdentityLookup {
  findIndexedAssetIdsForCanonicalAssets(assetIds: readonly string[]): Promise<string[]>;
}

interface SongDiscoveryQuery {
  seed?: string;
  limit?: string | number;
}

export async function registerSongDiscoveryRoutes(
  server: FastifyInstance,
  dependencies: SongDiscoveryRouteDependencies
): Promise<void> {
  server.get<{ Params: { roomSlug: string }; Querystring: SongDiscoveryQuery }>(
    "/rooms/:roomSlug/songs/discovery",
    async (request, reply) => {
      const room = await dependencies.rooms.findBySlug(request.params.roomSlug);
      if (!room) {
        await reply.code(404).send({ code: "ROOM_NOT_FOUND" });
        return;
      }

      const seed = String(request.query.seed ?? Date.now());
      const limit = parseLimit(request.query.limit);
      const queue = await dependencies.queueEntries.listEffectiveQueue(room.id);
      const songs =
        (await listIndexedDiscoverySongs({
          dependencies,
          queuedAssetIds: queue.map((entry) => entry.assetId)
        })) ??
        (await listFormalDiscoverySongs({
          dependencies,
          queuedSongIds: queue.map((entry) => entry.songId)
        }));

      const response: SongDiscoveryResponse = {
        seed,
        recommended: selectWeightedSongs(songs, limit, seed),
        artists: buildArtistModules(songs),
        genres: buildGenreModules(songs)
      };

      await reply.send(response);
    }
  );
}

function parseLimit(rawLimit: string | number | undefined): number {
  const parsedLimit =
    typeof rawLimit === "number" ? Math.trunc(rawLimit) : Number.parseInt(String(rawLimit ?? ""), 10);
  return Math.min(30, Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : 30));
}

async function listIndexedDiscoverySongs(input: {
  dependencies: SongDiscoveryRouteDependencies;
  queuedAssetIds: readonly string[];
}): Promise<SongDiscoverySong[] | null> {
  if (!input.dependencies.ktvIndex) {
    return null;
  }

  const queuedIndexedAssetIds =
    (await input.dependencies.indexedSources?.findIndexedAssetIdsForCanonicalAssets(input.queuedAssetIds)) ?? [];
  const records = await input.dependencies.ktvIndex.searchIndexedSongs({
    query: "",
    limit: 500,
    shuffle: true,
    versionsPerSong: 1,
    queuedIndexedAssetIds,
    unreadableIndexedAssetIds: []
  });
  if (records.length === 0) {
    return null;
  }

  const songIds = records.map((record) => ktvCanonicalSongId(record.indexedSongId));
  const requestCounts = (await input.dependencies.queueEntries.listGlobalSongRequestCounts?.(songIds)) ?? new Map<SongId, number>();
  return records.map((record) => indexedDiscoverySong(record, requestCounts.get(ktvCanonicalSongId(record.indexedSongId)) ?? 0));
}

async function listFormalDiscoverySongs(input: {
  dependencies: SongDiscoveryRouteDependencies;
  queuedSongIds: readonly SongId[];
}): Promise<SongDiscoverySong[]> {
  const records = await input.dependencies.songs.searchFormalSongs({
    query: "",
    limit: 500,
    queuedSongIds: input.queuedSongIds
  });
  const songIds = records.map((record) => record.song.id);
  const requestCounts = (await input.dependencies.queueEntries.listGlobalSongRequestCounts?.(songIds)) ?? new Map<SongId, number>();
  return records.map((record) => discoverySong(record, requestCounts.get(record.song.id) ?? 0));
}

function discoverySong(record: SearchFormalSongRecord, playCount: number): SongDiscoverySong {
  return {
    source: "formal",
    songId: record.song.id,
    title: record.song.title,
    artistId: record.song.artistId,
    artistName: record.song.artistName,
    language: record.song.language,
    genre: record.song.genre,
    matchReason: record.matchReason,
    queueState: record.queueState,
    versions: record.versions,
    playCount,
    recommendationWeight: recommendationWeight(record, playCount)
  };
}

function indexedDiscoverySong(record: SongSearchIndexedResult, playCount: number): SongDiscoverySong {
  const genre = indexedGenre(record);
  return {
    source: "ktv-index",
    songId: ktvCanonicalSongId(record.indexedSongId),
    indexedSongId: record.indexedSongId,
    title: record.title,
    artistId: indexedArtistId(record.artistName),
    artistName: record.artistName,
    language: "mandarin",
    genre,
    matchReason: record.matchReason === "style" ? "default" : record.matchReason,
    queueState: record.versions.some((version) => version.queueState === "queued") ? "queued" : "not_queued",
    versions: record.versions,
    playCount,
    recommendationWeight: indexedRecommendationWeight(playCount)
  };
}

function recommendationWeight(record: SearchFormalSongRecord, playCount: number): number {
  return Math.max(1, record.song.searchWeight) + playCount * 4;
}

function indexedRecommendationWeight(playCount: number): number {
  return 1 + playCount * 4;
}

function ktvCanonicalSongId(indexedSongId: string): SongId {
  return `song-ktv-${indexedSongId}` as SongId;
}

function indexedArtistId(artistName: string): string {
  const normalized = artistName
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return `ktv-index-artist-${normalized || "unknown"}`;
}

function indexedGenre(record: SongSearchIndexedResult): string[] {
  const tags = record.styleTags?.filter((tag) => tag.trim().length > 0) ?? [];
  return tags.length > 0 ? tags : [record.category || "未打标签"];
}

function selectWeightedSongs(songs: readonly SongDiscoverySong[], limit: number, seed: string): SongDiscoverySong[] {
  const remaining = [...songs];
  const selected: SongDiscoverySong[] = [];
  const random = seededRandom(seed);

  while (remaining.length > 0 && selected.length < limit) {
    const totalWeight = remaining.reduce((total, song) => total + song.recommendationWeight, 0);
    let cursor = random() * totalWeight;
    let selectedIndex = 0;
    for (let index = 0; index < remaining.length; index += 1) {
      cursor -= remaining[index]!.recommendationWeight;
      if (cursor <= 0) {
        selectedIndex = index;
        break;
      }
    }
    selected.push(remaining.splice(selectedIndex, 1)[0]!);
  }

  return selected;
}

function buildArtistModules(songs: readonly SongDiscoverySong[]): SongDiscoveryArtist[] {
  const byArtist = new Map<string, { artistId: string; artistName: string; songs: SongDiscoverySong[]; playCount: number }>();
  for (const song of songs) {
    const artistId = songArtistId(song);
    const record = byArtist.get(artistId) ?? {
      artistId,
      artistName: song.artistName,
      songs: [],
      playCount: 0
    };
    record.songs.push(song);
    record.playCount += song.playCount;
    byArtist.set(artistId, record);
  }

  return [...byArtist.values()]
    .sort((left, right) => right.playCount - left.playCount || right.songs.length - left.songs.length || left.artistName.localeCompare(right.artistName))
    .map((artist) => ({
      artistId: artist.artistId,
      artistName: artist.artistName,
      songCount: artist.songs.length,
      songs: artist.songs.sort(compareDiscoverySongs)
    }));
}

function buildGenreModules(songs: readonly SongDiscoverySong[]): SongDiscoveryGenre[] {
  const byGenre = new Map<string, { genre: string; songs: SongDiscoverySong[]; playCount: number }>();
  for (const song of songs) {
    for (const genre of song.genre.length > 0 ? song.genre : ["其他"]) {
      const record = byGenre.get(genre) ?? { genre, songs: [], playCount: 0 };
      record.songs.push(song);
      record.playCount += song.playCount;
      byGenre.set(genre, record);
    }
  }

  return [...byGenre.values()]
    .sort((left, right) => right.playCount - left.playCount || right.songs.length - left.songs.length || left.genre.localeCompare(right.genre))
    .map((genre) => ({
      genre: genre.genre,
      songCount: genre.songs.length,
      songs: genre.songs.sort(compareDiscoverySongs)
    }));
}

function compareDiscoverySongs(left: SongDiscoverySong, right: SongDiscoverySong): number {
  return right.playCount - left.playCount || right.recommendationWeight - left.recommendationWeight || left.title.localeCompare(right.title);
}

function songArtistId(song: SongDiscoverySong): string {
  return song.artistId;
}

function seededRandom(seed: string): () => number {
  let state = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    state ^= seed.charCodeAt(index);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
