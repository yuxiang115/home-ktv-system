import { readdir, readFile, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type {
  Asset,
  AssetId,
  AssetSourceType,
  Language,
  PlaybackProfile,
  Song,
  SongId,
  SongSearchMatchReason,
  SongSearchQueueState,
  SongSearchVersionOption,
  SwitchFamily,
  TrackRoles,
  VocalMode
} from "@home-ktv/domain";
import type { MediaPathMapping } from "../modules/assets/media-path-mapping.js";
import { mediaPathMappingTargets } from "../modules/assets/media-path-mapping.js";
import type { AssetRepository } from "../modules/catalog/repositories/asset-repository.js";
import {
  type AdminCatalogSongRecord,
  type AdminCatalogSongRepository,
  type ListFormalSongsFilters,
  type SearchFormalSongRecord,
  type SearchFormalSongsInput,
  type SongRepository,
  type UpdateSongMetadataInput
} from "../modules/catalog/repositories/song-repository.js";
import { buildPinyinSearchKeys, normalizeSearchText } from "../modules/catalog/search-normalization.js";

export interface LocalMediaCatalogOptions {
  mediaRoot: string;
  mediaPathMappings?: readonly MediaPathMapping[];
  now?: Date;
}

export interface LocalMediaCatalog {
  songs: AdminCatalogSongRepository & SongRepository;
  assets: AssetRepository;
  songCount: number;
  assetCount: number;
}

interface LocalCatalogData {
  songsById: Map<SongId, Song>;
  assetsById: Map<AssetId, Asset>;
  assetsBySongId: Map<SongId, Asset[]>;
}

interface LooseMediaMetadata {
  title: string;
  artistName: string;
  language: Language;
  genre: string[];
}

interface SongJsonRecord {
  title?: unknown;
  artistName?: unknown;
  language?: unknown;
  defaultVocalMode?: unknown;
  assets?: unknown;
}

interface SongJsonAsset {
  filePath?: unknown;
  vocalMode?: unknown;
  durationMs?: unknown;
  switchFamily?: unknown;
}

const mediaExtensions = new Set([".m4v", ".mkv", ".mp4", ".mpeg", ".mpg", ".webm"]);
const skippedDirectoryNames = new Set([".git", "dist", "generated", "imports", "node_modules"]);
const defaultDurationMs = 180_000;

export async function createLocalMediaCatalog(options: LocalMediaCatalogOptions): Promise<LocalMediaCatalog> {
  const data = await loadLocalCatalogData(options);
  return {
    songs: new LocalMediaSongRepository(data),
    assets: new LocalMediaAssetRepository(data),
    songCount: data.songsById.size,
    assetCount: data.assetsById.size
  };
}

async function loadLocalCatalogData(options: LocalMediaCatalogOptions): Promise<LocalCatalogData> {
  const data: LocalCatalogData = {
    songsById: new Map(),
    assetsById: new Map(),
    assetsBySongId: new Map()
  };
  const nowIso = (options.now ?? new Date()).toISOString();
  const mediaRoot = options.mediaRoot.trim() ? path.resolve(options.mediaRoot) : "";
  const knownMediaFiles = new Set<string>();

  if (mediaRoot) {
    await loadSongJsonRecords(data, { mediaRoot, nowIso, knownMediaFiles });
  }

  for (const root of catalogRoots(options)) {
    await loadLooseMediaRecords(data, { root, mediaRoot, nowIso, knownMediaFiles });
  }

  return data;
}

function catalogRoots(options: LocalMediaCatalogOptions): string[] {
  const roots = [
    options.mediaRoot.trim() ? path.resolve(options.mediaRoot) : "",
    ...mediaPathMappingTargets(options.mediaPathMappings ?? [])
  ].filter(Boolean);
  return Array.from(new Set(roots));
}

async function loadSongJsonRecords(
  data: LocalCatalogData,
  input: { mediaRoot: string; nowIso: string; knownMediaFiles: Set<string> }
): Promise<void> {
  const songsRoot = path.join(input.mediaRoot, "songs");
  if (!(await isDirectory(songsRoot))) {
    return;
  }

  for (const songJsonPath of await findFiles(songsRoot, (filePath) => path.basename(filePath) === "song.json")) {
    const parsed = await readSongJson(songJsonPath);
    if (!parsed) {
      continue;
    }

    const title = stringOrFallback(parsed.title, path.basename(path.dirname(songJsonPath)));
    const artistName = stringOrFallback(parsed.artistName, "Unknown Artist");
    const language = parseLanguage(parsed.language);
    const assets = Array.isArray(parsed.assets) ? parsed.assets.filter(isRecord) as SongJsonAsset[] : [];
    if (assets.length === 0) {
      continue;
    }

    const songId = localSongId(artistName, title);
    const songAssets = assets
      .map((asset, index) =>
        buildSongJsonAsset({
          songId,
          index,
          mediaRoot: input.mediaRoot,
          title,
          asset,
          nowIso: input.nowIso
        })
      )
      .filter((asset): asset is Asset => asset !== null);

    if (songAssets.length === 0) {
      continue;
    }

    for (const asset of songAssets) {
      input.knownMediaFiles.add(path.resolve(input.mediaRoot, asset.filePath));
    }

    const defaultVocalMode = parseVocalMode(parsed.defaultVocalMode) ?? "instrumental";
    const defaultAsset = songAssets.find((asset) => asset.vocalMode === defaultVocalMode) ?? songAssets[0]!;
    putSong(data, buildSong({
      songId,
      title,
      artistName,
      language,
      defaultAssetId: defaultAsset.id,
      genre: ["其他"],
      nowIso: input.nowIso,
      canSwitchVocalMode: songAssets.length > 1
    }));
    for (const asset of songAssets) {
      putAsset(data, asset);
    }
  }
}

function buildSongJsonAsset(input: {
  songId: SongId;
  index: number;
  mediaRoot: string;
  title: string;
  asset: SongJsonAsset;
  nowIso: string;
}): Asset | null {
  const filePath = typeof input.asset.filePath === "string" ? input.asset.filePath : "";
  if (!filePath) {
    return null;
  }

  const vocalMode = parseVocalMode(input.asset.vocalMode) ?? (input.index === 0 ? "original" : "instrumental");
  const switchFamily = typeof input.asset.switchFamily === "string" ? input.asset.switchFamily : `local-pair-${input.songId}`;
  return {
    id: localAssetId(path.resolve(input.mediaRoot, filePath), vocalMode),
    songId: input.songId,
    sourceType: "local",
    assetKind: "video",
    displayName: `${input.title} ${vocalMode === "original" ? "原唱" : "伴唱"}`,
    filePath,
    durationMs: numberOrFallback(input.asset.durationMs, defaultDurationMs),
    lyricMode: "hard_sub",
    vocalMode,
    status: "ready",
    switchFamily,
    switchQualityStatus: "verified",
    compatibilityStatus: "playable",
    compatibilityReasons: [],
    mediaInfoSummary: null,
    mediaInfoProvenance: null,
    trackRoles: emptyTrackRoles(),
    playbackProfile: separateAssetPlaybackProfile(),
    createdAt: input.nowIso,
    updatedAt: input.nowIso
  };
}

async function loadLooseMediaRecords(
  data: LocalCatalogData,
  input: { root: string; mediaRoot: string; nowIso: string; knownMediaFiles: Set<string> }
): Promise<void> {
  if (!(await isDirectory(input.root))) {
    return;
  }

  for (const mediaPath of await findFiles(input.root, isSupportedMediaFile)) {
    const resolvedMediaPath = path.resolve(mediaPath);
    if (input.knownMediaFiles.has(resolvedMediaPath) || shouldSkipLooseMediaFile(resolvedMediaPath, input.mediaRoot)) {
      continue;
    }

    const relativePath = path.relative(input.root, resolvedMediaPath).split(path.sep).join(path.posix.sep);
    const metadata = parseLooseMediaMetadata(relativePath);
    const fileStat = await stat(resolvedMediaPath);
    const songId = localSongId(metadata.artistName, metadata.title);
    const assetId = localAssetId(resolvedMediaPath, "dual");
    const existingSong = data.songsById.get(songId);

    putSong(
      data,
      buildSong({
        songId,
        title: metadata.title,
        artistName: metadata.artistName,
        language: metadata.language,
        genre: metadata.genre.length ? metadata.genre : ["其他"],
        defaultAssetId: existingSong?.defaultAssetId ?? assetId,
        nowIso: input.nowIso,
        canSwitchVocalMode: true
      })
    );
    putAsset(data, buildLooseMediaAsset({ assetId, songId, filePath: resolvedMediaPath, sizeBytes: fileStat.size, nowIso: input.nowIso }));
  }
}

function buildLooseMediaAsset(input: {
  assetId: AssetId;
  songId: SongId;
  filePath: string;
  sizeBytes: number;
  nowIso: string;
}): Asset {
  const playbackProfile: PlaybackProfile = {
    kind: "single_file_audio_tracks",
    container: path.extname(input.filePath).slice(1).toLowerCase() || null,
    videoCodec: null,
    audioCodecs: [],
    requiresAudioTrackSelection: true
  };

  return {
    id: input.assetId,
    songId: input.songId,
    sourceType: "local",
    assetKind: "dual-track-video",
    displayName: "本地真实 MV",
    filePath: input.filePath,
    durationMs: defaultDurationMs,
    lyricMode: "hard_sub",
    vocalMode: "dual",
    status: "ready",
    switchFamily: `local-real-mv-${input.songId}`,
    switchQualityStatus: "verified",
    compatibilityStatus: "playable",
    compatibilityReasons: [],
    mediaInfoSummary: {
      container: playbackProfile.container,
      durationMs: null,
      videoCodec: null,
      resolution: null,
      fileSizeBytes: input.sizeBytes,
      audioTracks: [{ index: 0, id: "0", label: "音轨 1", language: null, codec: null, channels: null }]
    },
    mediaInfoProvenance: { source: "manual", sourceVersion: null, probedAt: input.nowIso, importedFrom: input.filePath },
    trackRoles: {
      original: { index: 0, id: "0", label: "音轨 1" },
      instrumental: { index: 0, id: "0", label: "音轨 1" }
    },
    playbackProfile,
    createdAt: input.nowIso,
    updatedAt: input.nowIso
  };
}

function buildSong(input: {
  songId: SongId;
  title: string;
  artistName: string;
  language: Language;
  genre: string[];
  defaultAssetId: AssetId;
  nowIso: string;
  canSwitchVocalMode: boolean;
}): Song {
  const titleKeys = buildPinyinSearchKeys(input.title);
  const artistKeys = buildPinyinSearchKeys(input.artistName);
  return {
    id: input.songId,
    title: input.title,
    normalizedTitle: normalizeSearchText(input.title),
    titlePinyin: titleKeys.pinyin,
    titleInitials: titleKeys.initials,
    artistId: localArtistId(input.artistName),
    artistName: input.artistName,
    language: input.language,
    status: "ready",
    genre: input.genre,
    tags: ["本地曲库"],
    aliases: [],
    searchHints: [input.title, input.artistName],
    releaseYear: null,
    canonicalDurationMs: defaultDurationMs,
    searchWeight: 1,
    defaultAssetId: input.defaultAssetId,
    capabilities: {
      canSwitchVocalMode: input.canSwitchVocalMode
    },
    createdAt: input.nowIso,
    updatedAt: input.nowIso
  };
}

class LocalMediaSongRepository implements AdminCatalogSongRepository, SongRepository {
  constructor(private readonly data: LocalCatalogData) {}

  async findById(songId: SongId): Promise<Song | null> {
    return cloneSong(this.data.songsById.get(songId) ?? null);
  }

  async listFormalSongs(filters: ListFormalSongsFilters): Promise<AdminCatalogSongRecord[]> {
    const query = normalizeSearchText(filters.query ?? "");
    const songs = [...this.data.songsById.values()]
      .filter((song) => !filters.status || song.status === filters.status)
      .filter((song) => !filters.language || song.language === filters.language)
      .filter((song) => !query || songMatchesQuery(song, query))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.title.localeCompare(right.title))
      .slice(0, 100);
    return songs.map((song) => this.recordForSong(song));
  }

  async getFormalSongWithAssets(songId: SongId): Promise<AdminCatalogSongRecord | null> {
    const song = this.data.songsById.get(songId);
    return song ? this.recordForSong(song) : null;
  }

  async searchFormalSongs(input: SearchFormalSongsInput): Promise<SearchFormalSongRecord[]> {
    const query = normalizeSearchText(input.query);
    const queuedSongIds = new Set(input.queuedSongIds ?? []);
    const limit = Math.min(50, Math.max(1, input.limit ?? 30));
    return [...this.data.songsById.values()]
      .map((song) => searchRecordForSong(song, this.assetsForSong(song.id), query, queuedSongIds))
      .filter((record): record is SearchFormalSongRecord => record !== null)
      .sort((left, right) => right.score - left.score || left.song.title.localeCompare(right.song.title))
      .slice(0, limit);
  }

  async updateSongMetadata(_songId: SongId, _input: UpdateSongMetadataInput): Promise<AdminCatalogSongRecord | null> {
    return null;
  }

  async updateDefaultAsset(_songId: SongId, _assetId: AssetId): Promise<AdminCatalogSongRecord | null> {
    return null;
  }

  async updateSongStatus(_songId: SongId, _status: Song["status"]): Promise<AdminCatalogSongRecord | null> {
    return null;
  }

  private recordForSong(song: Song): AdminCatalogSongRecord {
    const assets = this.assetsForSong(song.id);
    return {
      song: cloneSong(song)!,
      assets: assets.map((asset) => cloneAsset(asset)!),
      defaultAsset: cloneAsset(assets.find((asset) => asset.id === song.defaultAssetId) ?? null)
    };
  }

  private assetsForSong(songId: SongId): Asset[] {
    return this.data.assetsBySongId.get(songId) ?? [];
  }
}

class LocalMediaAssetRepository implements AssetRepository {
  constructor(private readonly data: LocalCatalogData) {}

  async findById(assetId: AssetId): Promise<Asset | null> {
    return cloneAsset(this.data.assetsById.get(assetId) ?? null);
  }

  async findVerifiedSwitchCounterparts(asset: Asset): Promise<Asset[]> {
    if (!asset.switchFamily) {
      return [];
    }

    const assets = this.data.assetsBySongId.get(asset.songId) ?? [];
    return assets
      .filter((candidate) =>
        candidate.id !== asset.id &&
        candidate.switchFamily === asset.switchFamily &&
        candidate.vocalMode !== asset.vocalMode &&
        candidate.status === "ready" &&
        candidate.switchQualityStatus === "verified"
      )
      .map((asset) => cloneAsset(asset)!);
  }
}

function searchRecordForSong(
  song: Song,
  assets: readonly Asset[],
  query: string,
  queuedSongIds: ReadonlySet<SongId>
): SearchFormalSongRecord | null {
  const score = scoreSong(song, query);
  if (score <= 0 || assets.length === 0) {
    return null;
  }

  return {
    song: cloneSong(song)!,
    matchReason: matchReasonForSong(song, query),
    score,
    queueState: queuedSongIds.has(song.id) ? "queued" : "not_queued",
    versions: buildVersionOptions(song, assets)
  };
}

function buildVersionOptions(song: Song, assets: readonly Asset[]): SongSearchVersionOption[] {
  const byGroup = new Map<string, Asset[]>();
  for (const asset of assets.filter((asset) => asset.status === "ready" && asset.sourceType !== "online_ephemeral")) {
    const groupKey = asset.playbackProfile?.kind === "single_file_audio_tracks" || asset.assetKind === "dual-track-video"
      ? asset.id
      : asset.switchFamily ?? asset.id;
    const group = byGroup.get(groupKey) ?? [];
    group.push(asset);
    byGroup.set(groupKey, group);
  }

  return [...byGroup.values()].map((group, index) => {
    const representative = group.find((asset) => asset.id === song.defaultAssetId)
      ?? group.find((asset) => asset.vocalMode === "instrumental")
      ?? group[0]!;
    const queueState = queueStateForAsset(representative);
    return {
      assetId: representative.id,
      displayName: representative.displayName.trim() || "本地版本",
      sourceType: representative.sourceType,
      sourceLabel: sourceLabelFor(representative.sourceType),
      durationMs: representative.durationMs,
      qualityLabel: `${representative.assetKind} / ${Math.round(representative.durationMs / 1000)}s`,
      isRecommended: index === 0,
      queueState,
      canQueue: queueState === "queueable",
      disabledLabel: queueState === "queueable" ? null : "暂不可播放"
    };
  });
}

function queueStateForAsset(asset: Asset): SongSearchVersionOption["queueState"] {
  if (asset.playbackProfile?.kind === "single_file_audio_tracks" || asset.assetKind === "dual-track-video") {
    return asset.compatibilityStatus === "playable" && Boolean(asset.trackRoles?.instrumental)
      ? "queueable"
      : "missing_track_role";
  }
  return asset.switchQualityStatus === "verified" ? "queueable" : "temporarily_unavailable";
}

function scoreSong(song: Song, normalizedQuery: string): number {
  if (!normalizedQuery) {
    return 1;
  }
  if (song.normalizedTitle === normalizedQuery) {
    return 100;
  }
  if (normalizeSearchText(song.artistName) === normalizedQuery) {
    return 90;
  }
  if (song.normalizedTitle.includes(normalizedQuery) || normalizeSearchText(song.artistName).includes(normalizedQuery)) {
    return 70;
  }
  if (song.titlePinyin.includes(normalizedQuery) || song.artistName.includes(normalizedQuery)) {
    return 50;
  }
  if (song.titleInitials.includes(normalizedQuery)) {
    return 40;
  }
  if (song.aliases.some((alias) => normalizeSearchText(alias).includes(normalizedQuery))) {
    return 35;
  }
  if (song.searchHints.some((hint) => normalizeSearchText(hint).includes(normalizedQuery))) {
    return 30;
  }
  return 0;
}

function matchReasonForSong(song: Song, normalizedQuery: string): SongSearchMatchReason {
  if (!normalizedQuery) {
    return "default";
  }
  if (normalizeSearchText(song.artistName) === normalizedQuery || normalizeSearchText(song.artistName).includes(normalizedQuery)) {
    return "artist";
  }
  if (song.normalizedTitle === normalizedQuery) {
    return "title";
  }
  if (song.normalizedTitle.includes(normalizedQuery)) {
    return "normalized_title";
  }
  if (song.titlePinyin.includes(normalizedQuery)) {
    return "pinyin";
  }
  if (song.titleInitials.includes(normalizedQuery)) {
    return "initials";
  }
  if (song.aliases.some((alias) => normalizeSearchText(alias).includes(normalizedQuery))) {
    return "alias";
  }
  return "search_hint";
}

function songMatchesQuery(song: Song, normalizedQuery: string): boolean {
  return scoreSong(song, normalizedQuery) > 0;
}

function parseLooseMediaMetadata(relativePath: string): LooseMediaMetadata {
  const stem = stripExtension(path.basename(relativePath)).replace(/[－—–]/gu, "-");
  const parts = stem.split("-").map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const language = parseLanguage(parts.at(-2));
    const genre = parts.length >= 4 ? [parts.at(-1) ?? "其他"].filter(Boolean) : [];
    return {
      artistName: parts[0]!,
      title: stripDisplayMarker(parts.slice(1, language === "other" && parts.length > 2 ? -2 : -2).join("-") || parts[1]!),
      language,
      genre
    };
  }

  const folderArtist = relativePath.split("/").filter(Boolean).at(-2);
  return {
    artistName: folderArtist || "Unknown Artist",
    title: stripDisplayMarker(stem),
    language: "other",
    genre: []
  };
}

function stripDisplayMarker(value: string): string {
  return value.replace(/\s*[（(][^）)]*[）)]\s*$/u, "").trim() || value.trim();
}

function stripExtension(fileName: string): string {
  return fileName.slice(0, fileName.length - path.extname(fileName).length);
}

function parseLanguage(value: unknown): Language {
  const normalized = typeof value === "string" ? value.trim().replace(/\s+/gu, "") : "";
  if (normalized === "mandarin" || normalized === "国语" || normalized === "普通话") {
    return "mandarin";
  }
  if (normalized === "cantonese" || normalized === "粤语") {
    return "cantonese";
  }
  return "other";
}

function parseVocalMode(value: unknown): VocalMode | null {
  return value === "original" || value === "instrumental" || value === "dual" || value === "unknown" ? value : null;
}

async function findFiles(root: string, predicate: (filePath: string) => boolean): Promise<string[]> {
  const files: string[] = [];
  await walk(root, files, predicate);
  return files;
}

async function walk(directory: string, files: string[], predicate: (filePath: string) => boolean): Promise<void> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skippedDirectoryNames.has(entry.name)) {
        await walk(entryPath, files, predicate);
      }
    } else if (entry.isFile() && predicate(entryPath)) {
      files.push(entryPath);
    }
  }
}

function isSupportedMediaFile(filePath: string): boolean {
  return mediaExtensions.has(path.extname(filePath).toLowerCase());
}

function shouldSkipLooseMediaFile(filePath: string, mediaRoot: string): boolean {
  if (!mediaRoot) {
    return false;
  }
  const relative = path.relative(mediaRoot, filePath).split(path.sep);
  return relative[0] === "songs";
}

async function readSongJson(filePath: string): Promise<SongJsonRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function isDirectory(directory: string): Promise<boolean> {
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

function putSong(data: LocalCatalogData, song: Song): void {
  data.songsById.set(song.id, cloneSong(song)!);
}

function putAsset(data: LocalCatalogData, asset: Asset): void {
  data.assetsById.set(asset.id, cloneAsset(asset)!);
  const assets = data.assetsBySongId.get(asset.songId) ?? [];
  if (!assets.some((candidate) => candidate.id === asset.id)) {
    assets.push(cloneAsset(asset)!);
  }
  data.assetsBySongId.set(asset.songId, assets);
}

function emptyTrackRoles(): TrackRoles {
  return { original: null, instrumental: null };
}

function separateAssetPlaybackProfile(): PlaybackProfile {
  return {
    kind: "separate_asset_pair",
    container: null,
    videoCodec: null,
    audioCodecs: [],
    requiresAudioTrackSelection: false
  };
}

function sourceLabelFor(sourceType: AssetSourceType): string {
  return sourceType === "local" ? "本地" : "已缓存在线";
}

function stringOrFallback(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberOrFallback(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function localSongId(artistName: string, title: string): SongId {
  return `local-song-${hashStable(`${normalizeSearchText(artistName)}:${normalizeSearchText(title)}`)}`;
}

function localArtistId(artistName: string): string {
  return `local-artist-${hashStable(normalizeSearchText(artistName))}`;
}

function localAssetId(filePath: string, vocalMode: VocalMode): AssetId {
  return `local-asset-${hashStable(`${path.resolve(filePath)}:${vocalMode}`)}`;
}

function hashStable(value: string): string {
  let state = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    state ^= value.charCodeAt(index);
    state = Math.imul(state, 16777619);
  }
  return (state >>> 0).toString(36);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneSong(song: Song | null): Song | null {
  return song
    ? {
        ...song,
        genre: [...song.genre],
        tags: [...song.tags],
        aliases: [...song.aliases],
        searchHints: [...song.searchHints],
        capabilities: { ...song.capabilities }
      }
    : null;
}

function cloneAsset(asset: Asset | null): Asset | null {
  return asset ? JSON.parse(JSON.stringify(asset)) as Asset : null;
}
