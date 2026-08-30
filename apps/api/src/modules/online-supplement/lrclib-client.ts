// LRCLIB 开放 API 客户端:歌词流水线阶段与回填脚本共用。
import * as OpenCC from "opencc-js";

const traditionalToSimplified = OpenCC.Converter({ from: "t", to: "cn" });

export interface LrclibRecord {
  syncedLyrics?: string | null;
  plainLyrics?: string | null;
  instrumental?: boolean;
  trackName?: string;
  artistName?: string;
  duration?: number;
}

export interface FetchBestLrclibRecordInput {
  artistName: string;
  trackName: string;
  durationMs?: number | null | undefined;
  baseUrl: string;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const CLIENT_HEADER = { "Lrclib-Client": "home-ktv-system" } as const;

// LRCLIB 对简体命中更好:依次试 原文 → 简体(歌手去拉丁词,如 "光良Michael Wong"→"光良")。
// 流水线 lyrics 阶段与回填脚本共用,保证两边命中率一致。所有变体都因网络错误失败时
// 抛出最后一个错误(上层据此区分"查询失败"与"确实没有");单纯未命中返回 null。
export async function fetchBestLrclibWithVariants(
  input: FetchBestLrclibRecordInput
): Promise<{ record: LrclibRecord; variant: { artistName: string; trackName: string } } | null> {
  const variants = buildNameVariants(input.artistName, input.trackName);
  let lastError: unknown = null;
  let sawNetworkError = false;

  for (const variant of variants) {
    try {
      const record = await fetchBestLrclibRecord({ ...input, ...variant });
      if (record?.syncedLyrics?.trim()) {
        return { record, variant };
      }
    } catch (error) {
      sawNetworkError = true;
      lastError = error;
    }
  }

  if (sawNetworkError && lastError !== null) {
    throw lastError;
  }
  return null;
}

// "薛之謙_Joker_Xue-演員-國語-流行" → artist "薛之謙 Joker Xue", track "演員"。
// 在线补歌产物按 "歌手-歌名-语种-分类" 命名;回填脚本与 regenerate-lyrics 路由
// 都从文件名反查 LRCLIB,解析规则保持单份。
export function artistTrackFromStem(stem: string): { artistName: string; trackName: string } | null {
  const parts = stem.split("-").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) {
    return null;
  }
  const artistName = (parts[0] ?? "").replaceAll("_", " ").trim();
  const trackName = (parts[1] ?? "").replaceAll("_", " ").trim();
  if (!artistName || !trackName) {
    return null;
  }
  return { artistName, trackName };
}

export function buildNameVariants(artistName: string, trackName: string): Array<{ artistName: string; trackName: string }> {
  const simplifiedArtist = traditionalToSimplified(artistName);
  const simplifiedTrack = traditionalToSimplified(trackName);
  const cjkOnlyArtist = simplifiedArtist.replace(/[A-Za-z]+/gu, "").replace(/\s+/gu, " ").trim() || simplifiedArtist;
  const cjkOnlyTrack = simplifiedTrack.replace(/[A-Za-z]+/gu, "").replace(/\s+/gu, " ").trim() || simplifiedTrack;

  const variants = [
    { artistName, trackName },
    { artistName: simplifiedArtist, trackName: simplifiedTrack },
    { artistName: cjkOnlyArtist, trackName: cjkOnlyTrack }
  ];
  const seen = new Set<string>();
  return variants.filter((variant) => {
    const key = `${variant.artistName}|${variant.trackName}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

// 请求链:/api/get(带时长,精确)→ /api/get(不带时长)→ /api/search 取第一个
// 有 syncedLyrics 且非 instrumental 的记录。全部未命中返回 null。
export async function fetchBestLrclibRecord(input: FetchBestLrclibRecordInput): Promise<LrclibRecord | null> {
  const baseUrl = input.baseUrl.replace(/\/$/, "");
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const durationSeconds =
    typeof input.durationMs === "number" && input.durationMs > 0 ? Math.round(input.durationMs / 1000) : null;

  if (durationSeconds !== null) {
    const exact = await getLrclib(fetchImpl, baseUrl, timeoutMs, input.artistName, input.trackName, durationSeconds);
    if (exact) {
      return exact;
    }
  }

  const noDuration = await getLrclib(fetchImpl, baseUrl, timeoutMs, input.artistName, input.trackName, null);
  if (noDuration) {
    return noDuration;
  }

  const searchUrl = new URL(`${baseUrl}/api/search`);
  searchUrl.searchParams.set("artist_name", input.artistName);
  searchUrl.searchParams.set("track_name", input.trackName);
  const response = await fetchImpl(searchUrl, {
    headers: CLIENT_HEADER,
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    return null;
  }
  const results = (await response.json()) as LrclibRecord[];
  if (!Array.isArray(results)) {
    return null;
  }
  return results.find((item) => !item.instrumental && item.syncedLyrics?.trim()) ?? null;
}

async function getLrclib(
  fetchImpl: typeof fetch,
  baseUrl: string,
  timeoutMs: number,
  artistName: string,
  trackName: string,
  durationSeconds: number | null
): Promise<LrclibRecord | null> {
  const url = new URL(`${baseUrl}/api/get`);
  url.searchParams.set("artist_name", artistName);
  url.searchParams.set("track_name", trackName);
  if (durationSeconds !== null) {
    url.searchParams.set("duration", String(durationSeconds));
  }
  const response = await fetchImpl(url, {
    headers: CLIENT_HEADER,
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (response.status === 404 || !response.ok) {
    return null;
  }
  return (await response.json()) as LrclibRecord;
}
