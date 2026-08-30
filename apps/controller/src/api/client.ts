import type {
  ControllerSongHistoryResponse,
  SongDiscoveryResponse,
  SongDiscoverySongsResponse,
  SongSearchResponse
} from "@home-ktv/domain";
import type { ControlSessionInfo, RoomControlSnapshot, RoomInteractionEvent, RoomInteractionKind } from "@home-ktv/player-contracts";

const deviceIdStorageKey = "home_ktv_device_id";

export interface ControllerUser {
  phone: string;
  displayName: string;
}

export interface ControllerAuthResponse {
  user: ControllerUser;
}

export interface ControllerSessionResponse {
  controlSession: ControlSessionInfo;
  snapshot: RoomControlSnapshot | null;
}

export interface CommandAcceptedResponse {
  status: "accepted";
  commandId: string;
  sessionVersion: number;
  snapshot: RoomControlSnapshot;
  undo?: { queueEntryId: string; undoExpiresAt: string };
}

export interface CommandConflictResponse {
  code: "SESSION_VERSION_CONFLICT";
  latestSessionVersion: number;
  snapshot: RoomControlSnapshot;
}

export interface RoomInteractionAcceptedResponse {
  status: "accepted";
  interaction: RoomInteractionEvent;
}

export interface OnlineSupplementCandidate {
  provider: string;
  providerCandidateId: string;
  sourceUrl: string;
  title: string;
  artistName: string;
  durationMs: number | null;
  providerPayload: Record<string, unknown>;
}

export interface OnlineSupplementSearchResponse {
  query: string;
  candidates: OnlineSupplementCandidate[];
}

export interface OnlineSupplementRequestResponse {
  status: "accepted";
  taskId: string;
  taskStatus: string;
  stage: string;
}

// POST /media/ktv-index/:assetId/regenerate-lyrics:查不到歌词不是错误
export interface RegenerateLyricsResponse {
  status: "found" | "not_found";
  lyricFile?: string;
}

export class ControllerApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly payload: unknown
  ) {
    super(message);
  }
}

interface CommandBaseInput {
  roomSlug: string;
  deviceId: string;
  sessionVersion: number;
}

export function getOrCreateDeviceId(): string {
  try {
    const existing = localStorage.getItem(deviceIdStorageKey);
    if (existing) {
      return existing;
    }

    const deviceId = createId("mobile-");
    localStorage.setItem(deviceIdStorageKey, deviceId);
    return deviceId;
  } catch {
    return createId("mobile-");
  }
}

export async function restoreControlSession(input: {
  roomSlug: string;
  deviceId: string;
}): Promise<ControllerSessionResponse> {
  return fetchController<ControllerSessionResponse>(
    `/rooms/${encodeURIComponent(input.roomSlug)}/control-session?deviceId=${encodeURIComponent(input.deviceId)}`
  );
}

export async function createControlSession(input: {
  roomSlug: string;
  pairingToken: string;
  deviceId: string;
  deviceName?: string;
}): Promise<ControllerSessionResponse> {
  return fetchController<ControllerSessionResponse>(`/rooms/${encodeURIComponent(input.roomSlug)}/control-sessions`, {
    method: "POST",
    body: JSON.stringify({
      pairingToken: input.pairingToken,
      deviceId: input.deviceId,
      deviceName: input.deviceName ?? "Mobile Controller"
    })
  });
}

export async function getCurrentControllerUser(): Promise<ControllerAuthResponse> {
  return fetchController<ControllerAuthResponse>("/controller/auth/me");
}

export async function loginControllerUser(input: { phone: string; password: string }): Promise<ControllerAuthResponse> {
  return fetchController<ControllerAuthResponse>("/controller/auth/login", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function registerControllerUser(input: {
  phone: string;
  password: string;
  displayName: string;
}): Promise<ControllerAuthResponse> {
  return fetchController<ControllerAuthResponse>("/controller/auth/register", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function logoutControllerUser(): Promise<void> {
  await fetchController<void>("/controller/auth/logout", {
    method: "POST"
  });
}

export async function updateControllerUserProfile(input: { displayName: string }): Promise<ControllerAuthResponse> {
  return fetchController<ControllerAuthResponse>("/controller/auth/profile", {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export async function fetchControllerSongHistory(): Promise<ControllerSongHistoryResponse> {
  return fetchController<ControllerSongHistoryResponse>("/controller/me/song-history");
}

export async function searchSongs(input: {
  roomSlug: string;
  query: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<SongSearchResponse> {
  const init: RequestInit = input.signal ? { signal: input.signal } : {};
  return fetchController<SongSearchResponse>(
    `/rooms/${encodeURIComponent(input.roomSlug)}/songs/search?q=${encodeURIComponent(input.query)}&limit=${
      input.limit ?? 30
    }`,
    init
  );
}

export async function fetchSongDiscovery(input: {
  roomSlug: string;
  seed: string;
  signal?: AbortSignal;
}): Promise<SongDiscoveryResponse> {
  const init: RequestInit = input.signal ? { signal: input.signal } : {};
  return fetchController<SongDiscoveryResponse>(
    `/rooms/${encodeURIComponent(input.roomSlug)}/songs/discovery?seed=${encodeURIComponent(input.seed)}`,
    init
  );
}

export async function fetchDiscoveryArtistSongs(input: {
  roomSlug: string;
  artistId: string;
  offset?: number;
  limit?: number;
  signal?: AbortSignal;
}): Promise<SongDiscoverySongsResponse> {
  const init: RequestInit = input.signal ? { signal: input.signal } : {};
  return fetchController<SongDiscoverySongsResponse>(
    `/rooms/${encodeURIComponent(input.roomSlug)}/songs/discovery/artists/${encodeURIComponent(input.artistId)}/songs?offset=${
      input.offset ?? 0
    }&limit=${input.limit ?? 60}`,
    init
  );
}

export async function fetchDiscoveryGenreSongs(input: {
  roomSlug: string;
  genre: string;
  offset?: number;
  limit?: number;
  signal?: AbortSignal;
}): Promise<SongDiscoverySongsResponse> {
  const init: RequestInit = input.signal ? { signal: input.signal } : {};
  return fetchController<SongDiscoverySongsResponse>(
    `/rooms/${encodeURIComponent(input.roomSlug)}/songs/discovery/genres/songs?genre=${encodeURIComponent(input.genre)}&offset=${
      input.offset ?? 0
    }&limit=${input.limit ?? 60}`,
    init
  );
}

export async function fetchControlSnapshot(input: {
  roomSlug: string;
  deviceId: string;
}): Promise<RoomControlSnapshot | null> {
  const response = await restoreControlSession(input);
  return response.snapshot;
}

export async function addQueueEntry(
  input: CommandBaseInput & { sourceType: "nas" | "online"; assetId: string }
) {
  return sendCommand(input, "add-queue-entry", {
    sourceType: input.sourceType,
    assetId: input.assetId
  });
}

export async function deleteQueueEntry(input: CommandBaseInput & { queueEntryId: string }) {
  return sendCommand(input, "delete-queue-entry", { queueEntryId: input.queueEntryId });
}

export async function undoDeleteQueueEntry(input: CommandBaseInput & { queueEntryId: string }) {
  return sendCommand(input, "undo-delete-queue-entry", { queueEntryId: input.queueEntryId });
}

export async function promoteQueueEntry(input: CommandBaseInput & { queueEntryId: string }) {
  return sendCommand(input, "promote-queue-entry", { queueEntryId: input.queueEntryId });
}

export async function shuffleQueue(input: CommandBaseInput) {
  return sendCommand(input, "shuffle-queue", {});
}

export async function skipCurrent(input: CommandBaseInput & { confirmSkip: boolean }) {
  return sendCommand(input, "skip-current", { confirmSkip: input.confirmSkip });
}

export async function switchVocalMode(input: CommandBaseInput & { playbackPositionMs?: number }) {
  return sendCommand(input, "switch-vocal-mode", {
    playbackPositionMs: input.playbackPositionMs
  });
}

export async function seek(input: CommandBaseInput & { deltaMs: number }) {
  return sendCommand(input, "seek", { deltaMs: input.deltaMs });
}

export async function setVolume(input: CommandBaseInput & { volumePercent: number }) {
  return sendCommand(input, "set-volume", {
    volumePercent: input.volumePercent
  });
}

export async function sendRoomInteraction(input: {
  roomSlug: string;
  deviceId: string;
  kind: RoomInteractionKind;
  message: string;
}): Promise<RoomInteractionAcceptedResponse> {
  return fetchController<RoomInteractionAcceptedResponse>(
    `/rooms/${encodeURIComponent(input.roomSlug)}/interactions`,
    {
      method: "POST",
      body: JSON.stringify({
        deviceId: input.deviceId,
        kind: input.kind,
        message: input.message
      })
    }
  );
}

export async function searchOnlineSupplement(input: {
  roomSlug: string;
  deviceId: string;
  query: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<OnlineSupplementSearchResponse> {
  const init: RequestInit = input.signal ? { signal: input.signal } : {};
  const params = new URLSearchParams({
    deviceId: input.deviceId,
    q: input.query,
    limit: String(input.limit ?? 8)
  });
  return fetchController<OnlineSupplementSearchResponse>(
    `/rooms/${encodeURIComponent(input.roomSlug)}/online-supplement/search?${params.toString()}`,
    init
  );
}

export async function requestOnlineSupplement(input: {
  roomSlug: string;
  deviceId: string;
  candidate: OnlineSupplementCandidate;
}): Promise<OnlineSupplementRequestResponse> {
  return fetchController<OnlineSupplementRequestResponse>(
    `/rooms/${encodeURIComponent(input.roomSlug)}/online-supplement/request`,
    {
      method: "POST",
      body: JSON.stringify({
        deviceId: input.deviceId,
        provider: input.candidate.provider,
        providerCandidateId: input.candidate.providerCandidateId,
        sourceUrl: input.candidate.sourceUrl,
        title: input.candidate.title,
        artistName: input.candidate.artistName,
        durationMs: input.candidate.durationMs
      })
    }
  );
}

export async function regenerateAssetLyrics(input: {
  assetId: string;
  signal?: AbortSignal;
}): Promise<RegenerateLyricsResponse> {
  const init: RequestInit = { method: "POST", ...(input.signal ? { signal: input.signal } : {}) };
  return fetchController<RegenerateLyricsResponse>(
    `/media/ktv-index/${encodeURIComponent(input.assetId)}/regenerate-lyrics`,
    init
  );
}

export function realtimeUrl(input: { roomSlug: string; deviceId: string }): string {
  const path = `/rooms/${encodeURIComponent(input.roomSlug)}/realtime?deviceId=${encodeURIComponent(
    input.deviceId
  )}&client=mobile`;
  const base = apiBaseUrl();
  const httpUrl = new URL(path, base || window.location.origin);
  httpUrl.protocol = httpUrl.protocol === "https:" ? "wss:" : "ws:";
  return httpUrl.toString();
}

async function sendCommand(
  input: CommandBaseInput,
  command: string,
  payload: Record<string, unknown>
): Promise<CommandAcceptedResponse> {
  return fetchController<CommandAcceptedResponse>(
    `/rooms/${encodeURIComponent(input.roomSlug)}/commands/${command}`,
    {
      method: "POST",
      body: JSON.stringify({
        commandId: createCommandId(),
        sessionVersion: input.sessionVersion,
        deviceId: input.deviceId,
        ...payload
      })
    }
  );
}

// 房间号加入:房间快照的 pairing 信息本来就是公开的(电视二维码同源数据),
// 这里取 token 后由页面带 token 重新进入,复用既有的配对换会话流程
export async function joinRoomByRoomNumber(roomSlug: string): Promise<string> {
  const snapshot = await fetchController<{ pairing?: { token?: string } }>(
    `/rooms/${encodeURIComponent(roomSlug)}/snapshot`
  );
  const token = snapshot.pairing?.token;
  if (!token) {
    throw new Error("房间不存在或暂不可加入");
  }
  return token;
}

async function fetchController<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(controllerUrl(path), {
    ...init,
    credentials: "include",
    headers: buildHeaders(init)
  });

  if (!response.ok) {
    const payload = await readJson(response);
    const code = payload && typeof payload === "object" && "code" in payload ? String(payload.code) : null;
    throw new ControllerApiError(code ?? `Controller request failed with ${response.status}`, response.status, code, payload);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

function controllerUrl(path: string): string {
  if (/^https?:\/\//u.test(path)) {
    return path;
  }

  const baseUrl = apiBaseUrl();
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${baseUrl}${normalizedPath}`;
}

function apiBaseUrl(): string {
  // 优先用页面自身地址推导 API(同 host、端口换 4000):手机无论从局域网 IP 还是
  // Tailscale IP 打开控制器,API 都与页面同站,auth cookie(SameSite=Lax)必定随
  // 请求发送。烤死的 VITE 绝对地址只作无 location 环境(测试)的兜底——一旦手机
  // 换了网络入口,烤死地址会变成跨站,登录态全部失效。
  const origin = globalThis.location?.origin ?? "";
  if (origin) {
    try {
      const url = new URL(origin);
      url.port = "4000";
      return url.toString().replace(/\/$/, "");
    } catch {
      // fall through to configured base
    }
  }
  return import.meta.env.VITE_API_BASE_URL?.replace(/\/$/u, "") ?? "";
}

function buildHeaders(init: RequestInit): HeadersInit {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return headers;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function createCommandId(): string {
  return createId("mobile-command-");
}

function createId(prefix: string): string {
  const randomPart =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `${prefix}${randomPart}`;
}
