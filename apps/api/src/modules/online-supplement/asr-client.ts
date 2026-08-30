// Qwen3-ASR 转写客户端(OpenAI whisper 风格 /v1/audio/transcriptions)。
// 服务端(跑在用户 Mac 上)不在本仓库范围;这里只做 HTTP 客户端。
// LRCLIB 未命中时用它从 MV 音频直接转写歌词:转写时间戳与 MV 天然同步,
// 而录音室版计时 LRCLIB 歌词对不上带片头的 MV。
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

/** 一段带时间戳的转写文本;start/end 单位为秒 */
export interface AsrSegment {
  start: number;
  end: number;
  text: string;
}

export interface AsrTranscription {
  text: string;
  segments: readonly AsrSegment[];
}

export interface TranscribeAudioInput {
  baseUrl: string;
  model: string;
  filePath: string;
  /** 上下文提示(如歌手/歌名),提升专有名词识别率 */
  prompt?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

/** 转写函数签名;路由 context 注入 fake 时用(测试跳过真实 HTTP) */
export type AsrTranscriber = (input: TranscribeAudioInput) => Promise<AsrTranscription>;

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

// multipart:file(音频)+ model(+ prompt)。Node 18+ 原生 FormData/Blob。
export async function transcribeAudio(input: TranscribeAudioInput): Promise<AsrTranscription> {
  const baseUrl = input.baseUrl.replace(/\/+$/, "");
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const audio = await readFile(input.filePath);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: audioMimeType(input.filePath) }), basename(input.filePath));
  form.append("model", input.model);
  if (input.prompt) {
    form.append("prompt", input.prompt);
  }

  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/v1/audio/transcriptions`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw new Error(`ASR request failed: ${errorMessage(error)}`);
  }

  if (!response.ok) {
    throw new Error(`ASR request failed: HTTP ${response.status}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(`ASR response is not JSON: ${errorMessage(error)}`);
  }
  return parseTranscription(payload);
}

// 响应 {text, segments?: [{start, end, text}]}(秒);segments 缺失/非法一律回空数组,
// 由调用方决定"无时间轴"分支。
export function parseTranscription(payload: unknown): AsrTranscription {
  if (typeof payload !== "object" || payload === null) {
    return { text: "", segments: [] };
  }
  const record = payload as { text?: unknown; segments?: unknown };
  const text = typeof record.text === "string" ? record.text : "";
  const segments = Array.isArray(record.segments)
    ? record.segments.filter(
        (segment): segment is AsrSegment =>
          typeof segment === "object" &&
          segment !== null &&
          typeof (segment as AsrSegment).start === "number" &&
          Number.isFinite((segment as AsrSegment).start) &&
          typeof (segment as AsrSegment).text === "string"
      )
    : [];
  return { text, segments };
}

function audioMimeType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".m4a":
    case ".mp4":
      return "audio/mp4";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".flac":
      return "audio/flac";
    default:
      return "application/octet-stream";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
