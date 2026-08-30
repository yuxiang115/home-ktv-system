import { parseMediaPathMappings, type MediaPathMapping } from "./modules/assets/media-path-mapping.js";

export interface ApiConfig {
  corsAllowedOrigins: readonly string[];
  databaseUrl: string;
  controllerBaseUrl?: string;
  mediaPathMappings: readonly MediaPathMapping[];
  mediaRoot: string;
  onlineDemoReadyAssetId: string;
  onlineProviderIds: readonly string[];
  onlineProviderKillSwitchIds: readonly string[];
  onlineSupplementEnabled: boolean;
  onlineSupplementWorkflow: string;
  supplementImportRoot: string;
  supplementBatchSize: number;
  lyricsLrclibBaseUrl: string;
  ytDlpBin: string;
  ytDlpArgs: string;
  youtubePlayerClient: string;
  youtubeCookie: string;
  youtubeCookiesFromBrowser: string;
  demucsBin: string;
  demucsArgs: string;
  demucsDevice: string;
  demucsModel: string;
  alignerBin: string;
  alignerModel: string;
  alignerDevice: string;
  alignerDtype: string;
  alignerScript: string;
  ffmpegBin: string;
  publicBaseUrl: string;
  roomSlug: string;
  port: number;
  host: string;
  scanIntervalMinutes: number;
}

export type ApiConfigInput = Omit<
  ApiConfig,
  | "mediaPathMappings"
  | "onlineDemoReadyAssetId"
  | "onlineProviderIds"
  | "onlineProviderKillSwitchIds"
  | "onlineSupplementEnabled"
  | "onlineSupplementWorkflow"
  | "supplementImportRoot"
  | "supplementBatchSize"
  | "lyricsLrclibBaseUrl"
  | "ytDlpBin"
  | "ytDlpArgs"
  | "youtubePlayerClient"
  | "youtubeCookie"
  | "youtubeCookiesFromBrowser"
  | "demucsBin"
  | "demucsArgs"
  | "demucsDevice"
  | "demucsModel"
  | "alignerBin"
  | "alignerModel"
  | "alignerDevice"
  | "alignerDtype"
  | "alignerScript"
  | "ffmpegBin"
  | "scanIntervalMinutes"
> & {
  mediaPathMappings?: readonly MediaPathMapping[];
  onlineDemoReadyAssetId?: string;
  onlineProviderIds?: readonly string[];
  onlineProviderKillSwitchIds?: readonly string[];
  onlineSupplementEnabled?: boolean;
  onlineSupplementWorkflow?: string;
  supplementImportRoot?: string;
  supplementBatchSize?: number;
  lyricsLrclibBaseUrl?: string;
  ytDlpBin?: string;
  ytDlpArgs?: string;
  youtubePlayerClient?: string;
  youtubeCookie?: string;
  youtubeCookiesFromBrowser?: string;
  demucsBin?: string;
  demucsArgs?: string;
  demucsDevice?: string;
  demucsModel?: string;
  alignerBin?: string;
  alignerModel?: string;
  alignerDevice?: string;
  alignerDtype?: string;
  alignerScript?: string;
  ffmpegBin?: string;
  scanIntervalMinutes?: number;
};

const DEFAULT_ROOM_SLUG = "living-room";
const DEFAULT_PORT = 4000;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_SCAN_INTERVAL_MINUTES = 360;
const DEFAULT_ONLINE_SUPPLEMENT_WORKFLOW = "youtube-enhanced";
const DEFAULT_SUPPLEMENT_BATCH_SIZE = 4;
const DEFAULT_LYRICS_LRCLIB_BASE_URL = "https://lrclib.net";
const DEFAULT_DEMUCS_MODEL = "htdemucs";
const DEFAULT_YOUTUBE_PLAYER_CLIENT = "android";
const DEFAULT_ALIGNER_MODEL = "Qwen/Qwen3-ForcedAligner-0.6B";
const DEFAULT_ALIGNER_DEVICE = "cuda:0";
const DEFAULT_ALIGNER_DTYPE = "bfloat16";
const DEFAULT_ALIGNER_SCRIPT = "python/align_lyrics.py";

function readString(value: string | undefined): string {
  return value?.trim() ?? "";
}

function readPort(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_PORT;
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readBoolean(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return {
    corsAllowedOrigins: readList(env.CORS_ALLOWED_ORIGINS),
    databaseUrl: readString(env.DATABASE_URL),
    controllerBaseUrl: readString(env.CONTROLLER_BASE_URL),
    mediaPathMappings: parseMediaPathMappings(env.MEDIA_PATH_MAPPINGS),
    mediaRoot: readString(env.MEDIA_ROOT),
    onlineDemoReadyAssetId: readString(env.ONLINE_DEMO_READY_ASSET_ID),
    onlineProviderIds: readList(env.ONLINE_PROVIDER_IDS),
    onlineProviderKillSwitchIds: readList(env.ONLINE_PROVIDER_KILL_SWITCH_IDS),
    onlineSupplementEnabled: readBoolean(env.ONLINE_SUPPLEMENT_ENABLED),
    onlineSupplementWorkflow: readString(env.ONLINE_SUPPLEMENT_WORKFLOW) || DEFAULT_ONLINE_SUPPLEMENT_WORKFLOW,
    supplementImportRoot: readString(env.SUPPLEMENT_IMPORT_ROOT),
    supplementBatchSize: readPositiveInteger(env.SUPPLEMENT_BATCH_SIZE, DEFAULT_SUPPLEMENT_BATCH_SIZE),
    lyricsLrclibBaseUrl: readString(env.LYRICS_LRCLIB_BASE_URL) || DEFAULT_LYRICS_LRCLIB_BASE_URL,
    ytDlpBin: readString(env.YT_DLP_BIN) || "yt-dlp",
    ytDlpArgs: readString(env.YT_DLP_ARGS),
    youtubePlayerClient: env.YOUTUBE_PLAYER_CLIENT !== undefined ? readString(env.YOUTUBE_PLAYER_CLIENT) : DEFAULT_YOUTUBE_PLAYER_CLIENT,
    youtubeCookie: readString(env.YOUTUBE_COOKIE),
    youtubeCookiesFromBrowser: readString(env.YOUTUBE_COOKIES_FROM_BROWSER),
    demucsBin: readString(env.DEMUCS_BIN) || "demucs",
    demucsArgs: readString(env.DEMUCS_ARGS),
    demucsDevice: readString(env.DEMUCS_DEVICE) || "cpu",
    demucsModel: readString(env.DEMUCS_MODEL) || DEFAULT_DEMUCS_MODEL,
    alignerBin: readString(env.ALIGNER_BIN),
    alignerModel: readString(env.ALIGNER_MODEL) || DEFAULT_ALIGNER_MODEL,
    alignerDevice: readString(env.ALIGNER_DEVICE) || DEFAULT_ALIGNER_DEVICE,
    alignerDtype: readString(env.ALIGNER_DTYPE) || DEFAULT_ALIGNER_DTYPE,
    alignerScript: readString(env.ALIGNER_SCRIPT) || DEFAULT_ALIGNER_SCRIPT,
    ffmpegBin: readString(env.FFMPEG_BIN) || "ffmpeg",
    publicBaseUrl: readString(env.PUBLIC_BASE_URL),
    roomSlug: readString(env.TV_ROOM_SLUG) || DEFAULT_ROOM_SLUG,
    port: readPort(env.PORT),
    host: readString(env.HOST) || DEFAULT_HOST,
    scanIntervalMinutes: readPositiveInteger(env.SCAN_INTERVAL_MINUTES, DEFAULT_SCAN_INTERVAL_MINUTES)
  };
}

export function normalizeApiConfig(config: ApiConfigInput): ApiConfig {
  return {
    ...config,
    mediaPathMappings: config.mediaPathMappings ?? [],
    onlineDemoReadyAssetId: config.onlineDemoReadyAssetId ?? "",
    onlineProviderIds: config.onlineProviderIds ?? [],
    onlineProviderKillSwitchIds: config.onlineProviderKillSwitchIds ?? [],
    onlineSupplementEnabled: config.onlineSupplementEnabled ?? false,
    onlineSupplementWorkflow: config.onlineSupplementWorkflow || DEFAULT_ONLINE_SUPPLEMENT_WORKFLOW,
    supplementImportRoot: config.supplementImportRoot ?? "",
    supplementBatchSize: config.supplementBatchSize ?? DEFAULT_SUPPLEMENT_BATCH_SIZE,
    lyricsLrclibBaseUrl: config.lyricsLrclibBaseUrl || DEFAULT_LYRICS_LRCLIB_BASE_URL,
    ytDlpBin: config.ytDlpBin ?? "yt-dlp",
    ytDlpArgs: config.ytDlpArgs ?? "",
    youtubePlayerClient: config.youtubePlayerClient ?? DEFAULT_YOUTUBE_PLAYER_CLIENT,
    youtubeCookie: config.youtubeCookie ?? "",
    youtubeCookiesFromBrowser: config.youtubeCookiesFromBrowser ?? "",
    demucsBin: config.demucsBin ?? "demucs",
    demucsArgs: config.demucsArgs ?? "",
    demucsDevice: config.demucsDevice ?? "cpu",
    demucsModel: config.demucsModel || DEFAULT_DEMUCS_MODEL,
    alignerBin: config.alignerBin ?? "",
    alignerModel: config.alignerModel || DEFAULT_ALIGNER_MODEL,
    alignerDevice: config.alignerDevice || DEFAULT_ALIGNER_DEVICE,
    alignerDtype: config.alignerDtype || DEFAULT_ALIGNER_DTYPE,
    alignerScript: config.alignerScript || DEFAULT_ALIGNER_SCRIPT,
    ffmpegBin: config.ffmpegBin ?? "ffmpeg",
    scanIntervalMinutes: config.scanIntervalMinutes ?? DEFAULT_SCAN_INTERVAL_MINUTES
  };
}
