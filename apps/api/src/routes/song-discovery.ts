import type { FastifyInstance } from "fastify";
import type {
  SongDiscoveryArtist,
  SongDiscoveryGenre,
  SongDiscoveryResponse,
  SongDiscoverySong,
  SongId,
  SongSearchIndexedResult
} from "@home-ktv/domain";
import { songCoverCacheKey } from "../modules/covers/types.js";
import type { SongCoverCacheRepository } from "../modules/covers/song-cover-cache-repository.js";
import type { KtvIndexReadRepository } from "../modules/ktv-index/ktv-index-read-repository.js";
import type { QueueEntryRepository } from "../modules/playback/repositories/queue-entry-repository.js";
import type { RoomRepository } from "../modules/rooms/repositories/room-repository.js";

export interface SongDiscoveryRouteDependencies {
  rooms: RoomRepository;
  queueEntries: QueueEntryRepository;
  ktvIndex?: Pick<KtvIndexReadRepository, "searchIndexedSongs">;
  coverCache?: Pick<SongCoverCacheRepository, "findBySongKeys">;
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
      const songs = await listNasDiscoverySongs({
        dependencies,
        queuedAssetIds: queue
          .filter((entry) => (entry.source?.sourceType ?? "nas") === "nas")
          .map((entry) => entry.source?.assetId ?? entry.assetId)
      });
      const songsWithCovers = await attachCoverImageUrls(songs, dependencies.coverCache);
      const weightedRecommendations = selectWeightedSongs(songsWithCovers, limit, seed);

      const response: SongDiscoveryResponse = {
        seed,
        recommended: surfaceCoveredSongs(weightedRecommendations, songsWithCovers, limit, seed),
        artists: buildArtistModules(songsWithCovers),
        genres: buildGenreModules(songsWithCovers)
      };

      await reply.send(response);
    }
  );
}

async function attachCoverImageUrls(
  songs: readonly SongDiscoverySong[],
  coverCache: Pick<SongCoverCacheRepository, "findBySongKeys"> | undefined
): Promise<SongDiscoverySong[]> {
  if (!coverCache || songs.length === 0) {
    return [...songs];
  }

  const keys = songs.map((song) => ({
    source: song.source,
    sourceSongId: discoverySourceSongId(song)
  }));
  const covers = await coverCache.findBySongKeys(keys);

  return songs.map((song) => {
    const cover = covers.get(
      songCoverCacheKey({
        source: song.source,
        sourceSongId: discoverySourceSongId(song)
      })
    );
    return cover?.imageUrl ? { ...song, coverImageUrl: cover.imageUrl } : song;
  });
}

function parseLimit(rawLimit: string | number | undefined): number {
  const parsedLimit =
    typeof rawLimit === "number" ? Math.trunc(rawLimit) : Number.parseInt(String(rawLimit ?? ""), 10);
  return Math.min(30, Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : 30));
}

async function listNasDiscoverySongs(input: {
  dependencies: SongDiscoveryRouteDependencies;
  queuedAssetIds: readonly string[];
}): Promise<SongDiscoverySong[]> {
  if (!input.dependencies.ktvIndex) {
    return [];
  }

  const records = await input.dependencies.ktvIndex.searchIndexedSongs({
    query: "",
    limit: 500,
    shuffle: true,
    versionsPerSong: 1,
    queuedIndexedAssetIds: input.queuedAssetIds,
    unreadableIndexedAssetIds: []
  });

  const songIds = records.map((record) => record.indexedSongId as SongId);
  const requestCounts = (await input.dependencies.queueEntries.listGlobalSongRequestCounts?.(songIds)) ?? new Map<SongId, number>();
  return records.map((record) => nasDiscoverySong(record, requestCounts.get(record.indexedSongId as SongId) ?? 0));
}

function nasDiscoverySong(record: SongSearchIndexedResult, playCount: number): SongDiscoverySong {
  const genre = nasGenre(record);
  return {
    source: "nas",
    songId: record.indexedSongId,
    title: record.title,
    artistId: nasArtistId(record.artistName),
    artistName: record.artistName,
    language: "mandarin",
    genre,
    matchReason: record.matchReason === "style" ? "default" : record.matchReason,
    queueState: record.versions.some((version) => version.queueState === "queued") ? "queued" : "not_queued",
    versions: record.versions.map((version) => ({
      assetId: version.indexedAssetId,
      displayName: version.displayName,
      sourceLabel: "NAS曲库",
      extension: version.extension,
      sizeBytes: version.sizeBytes,
      audioTrackCount: version.audioTrackCount,
      ...(version.styleTags ? { styleTags: version.styleTags } : {}),
      category: version.category,
      queueState: version.queueState,
      canQueue: version.canQueue,
      disabledLabel: version.disabledLabel
    })),
    playCount,
    recommendationWeight: nasRecommendationWeight(playCount)
  };
}

function nasRecommendationWeight(playCount: number): number {
  return 1 + playCount * 4;
}

function discoverySourceSongId(song: SongDiscoverySong): string {
  return song.songId;
}

function nasArtistId(artistName: string): string {
  const normalized = artistName
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return `nas-artist-${normalized || "unknown"}`;
}

function nasGenre(record: SongSearchIndexedResult): string[] {
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

function surfaceCoveredSongs(
  selected: readonly SongDiscoverySong[],
  candidates: readonly SongDiscoverySong[],
  limit: number,
  seed: string
): SongDiscoverySong[] {
  const targetCoverCount = Math.min(6, limit, candidates.filter(hasCoverImage).length);
  const currentCoverCount = selected.filter(hasCoverImage).length;
  if (currentCoverCount >= targetCoverCount) {
    return [...selected];
  }

  const selectedIds = new Set(selected.map((song) => song.songId));
  const additionalCoveredSongs = selectWeightedSongs(
    candidates.filter((song) => hasCoverImage(song) && !selectedIds.has(song.songId)),
    targetCoverCount - currentCoverCount,
    `${seed}:covers`
  );
  if (additionalCoveredSongs.length === 0) {
    return [...selected];
  }

  const selectedWithReplacementSlots = [...selected];
  const promotedSongs: SongDiscoverySong[] = [];
  for (const coveredSong of additionalCoveredSongs) {
    const replacementIndex = lastUncoveredSongIndex(selectedWithReplacementSlots);
    if (replacementIndex < 0) {
      break;
    }
    selectedWithReplacementSlots.splice(replacementIndex, 1);
    promotedSongs.push(coveredSong);
  }

  if (promotedSongs.length === 0) {
    return [...selected];
  }

  return [...promotedSongs, ...selectedWithReplacementSlots].slice(0, limit);
}

function hasCoverImage(song: SongDiscoverySong): boolean {
  return typeof song.coverImageUrl === "string" && song.coverImageUrl.length > 0;
}

function lastUncoveredSongIndex(songs: readonly SongDiscoverySong[]): number {
  for (let index = songs.length - 1; index >= 0; index -= 1) {
    if (!hasCoverImage(songs[index]!)) {
      return index;
    }
  }
  return -1;
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
