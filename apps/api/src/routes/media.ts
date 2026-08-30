import { createReadStream } from "node:fs";
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { spawn } from "node:child_process";
import { basename, dirname, extname, join } from "node:path";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from "fastify";
import { DEFAULT_ASR_MODEL } from "../config.js";
import { inferVideoContentType } from "../modules/media/content-type.js";
import { artistTrackFromStem, fetchBestLrclibWithVariants } from "../modules/online-supplement/lrclib-client.js";
import { transcribeAudio, type AsrSegment, type AsrTranscriber } from "../modules/online-supplement/asr-client.js";
import type { MediaPathResolver, MediaPathResolution } from "../modules/assets/media-path-resolver.js";
import type { QueryExecutor } from "../db/query-executor.js";
import type { MediaGateway, MediaGatewayResolution } from "../modules/media/media-gateway.js";

const execFileAsync = promisify(execFile);
const safeNasCoverFileName = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.jpg$/u;
const defaultLrclibBaseUrl = "https://lrclib.net";

export interface MediaRouteContext {
  coverRoot?: string;
  mediaGateway?: Pick<MediaGateway, "resolveForStreaming">;
  ktvIndexRawAssets?: KtvIndexRawAssetRepository;
  mediaPathResolver?: MediaPathResolver;
  /** regenerate-lyrics 查 LRCLIB 用的基地址(默认 https://lrclib.net) */
  lrclibBaseUrl?: string;
  /** 注入 fetch 实现(测试用);缺省用全局 fetch */
  lyricsFetchImpl?: typeof fetch;
  /** ASR 转写服务基地址(Qwen3-ASR,whisper 风格);空 = LRCLIB 未命中后不做转写 */
  asrBaseUrl?: string;
  /** ASR 模型名(透传给 /v1/audio/transcriptions) */
  asrModel?: string;
  /** mkv → 16k mono m4a 抽音频步骤(默认 ffmpeg);测试注入以跳过真实 ffmpeg */
  asrAudioExtractor?: AsrAudioExtractor;
  /** 转写步骤(默认 transcribeAudio);测试注入 fake */
  asrTranscriber?: AsrTranscriber;
  /** remux 选轨流(切伴奏 fallback)用的 ffmpeg;缺省为 PATH 上的 ffmpeg */
  ffmpegBin?: string;
  /** remux 选轨流 start 偏移探测用的 ffprobe;缺省由 ffmpegBin 同目录推导(或 PATH 上的 ffprobe) */
  ffprobeBin?: string;
  /** remux 选轨流 start 偏移探测步骤(默认 probeRemuxStartOffsetWithFfprobe);测试注入 fake */
  remuxStartOffsetProber?: RemuxStartOffsetProber;
  log?: FastifyBaseLogger;
}

/** 抽音频步骤:输入 mkv 路径,产出 ASR 用的 16kHz mono 音频文件 */
export type AsrAudioExtractor = (input: {
  ffmpegBin: string;
  filePath: string;
  outputPath: string;
}) => Promise<void>;

/** remux 选轨流 start 偏移探测步骤:返回 "-c copy 回退 keyframe" 造成的流起点提前量(ms);探测不到返回 null */
export type RemuxStartOffsetProber = (input: {
  ffprobeBin: string;
  filePath: string;
  startMs: number;
}) => Promise<number | null>;

export async function registerMediaRoutes(fastify: FastifyInstance, context: MediaRouteContext): Promise<void> {
  fastify.get<{ Params: { "*": string } }>("/media/covers/nas/thumbs/*", async (request, reply) => {
    if (!context.coverRoot) {
      return reply.status(503).send({ error: "SONG_COVER_MEDIA_UNAVAILABLE" });
    }

    const songId = parseNasCoverSongId(request.params["*"]);
    if (!songId) {
      return reply.status(400).send({ error: "INVALID_COVER_ID" });
    }

    return sendNasCoverImage(reply, {
      filePath: join(context.coverRoot, "nas", "thumbs", `${songId}.jpg`),
      rangeHeader: request.headers.range
    });
  });

  fastify.get<{ Params: { "*": string } }>("/media/covers/nas/*", async (request, reply) => {
    if (!context.coverRoot) {
      return reply.status(503).send({ error: "SONG_COVER_MEDIA_UNAVAILABLE" });
    }

    const songId = parseNasCoverSongId(request.params["*"]);
    if (!songId) {
      return reply.status(400).send({ error: "INVALID_COVER_ID" });
    }

    return sendNasCoverImage(reply, {
      filePath: join(context.coverRoot, "nas", `${songId}.jpg`),
      rangeHeader: request.headers.range
    });
  });

  fastify.get<{ Params: { indexedAssetId: string } }>(
    "/media/ktv-index/:indexedAssetId/raw",
    async (request, reply) => {
      if (!context.ktvIndexRawAssets || !context.mediaPathResolver) {
        return reply.status(503).send({ error: "KTV_INDEX_RAW_MEDIA_UNAVAILABLE" });
      }

      const row = await context.ktvIndexRawAssets.findRawAssetById(request.params.indexedAssetId);
      if (!row) {
        return reply.status(404).send({ error: "KTV_INDEX_ASSET_NOT_FOUND" });
      }

      const resolved = await context.mediaPathResolver.resolveAssetFile(row.filePath);
      if (!resolved.ok) {
        return sendRawMediaPathError(reply, resolved);
      }

      return sendResolvedMedia(reply, {
        filePath: resolved.filePath,
        contentLength: resolved.sizeBytes,
        contentType: inferVideoContentType(row.filePath),
        rangeHeader: request.headers.range
      });
    }
  );

  // 同步歌词(.lrc 纯文本)。TV 端按歌拉一次,404 = 该歌无歌词(静默处理)。
  fastify.get<{ Params: { indexedAssetId: string } }>(
    "/media/ktv-index/:indexedAssetId/lyrics",
    async (request, reply) => {
      if (!context.ktvIndexRawAssets || !context.mediaPathResolver) {
        return reply.status(503).send({ error: "KTV_INDEX_RAW_MEDIA_UNAVAILABLE" });
      }

      const row = await context.ktvIndexRawAssets.findRawAssetById(request.params.indexedAssetId);
      if (!row) {
        return reply.status(404).send({ error: "KTV_INDEX_ASSET_NOT_FOUND" });
      }
      if (!row.lyricFile) {
        return reply.status(404).send({ error: "LYRICS_NOT_FOUND" });
      }

      const resolved = await context.mediaPathResolver.resolveAssetFile(row.lyricFile);
      if (!resolved.ok) {
        return sendRawMediaPathError(reply, resolved);
      }

      try {
        const content = await readFile(resolved.filePath, "utf8");
        return reply
          .type("text/plain; charset=utf-8")
          .header("cache-control", "no-store")
          .send(content);
      } catch {
        return reply.status(404).send({ error: "LYRICS_NOT_FOUND" });
      }
    }
  );

  // 逐字 karaoke 时间轴(align 阶段产出)。TV 优先用它做逐字点亮,404 = 降级行级 LRC。
  fastify.get<{ Params: { indexedAssetId: string } }>(
    "/media/ktv-index/:indexedAssetId/karaoke-lyrics",
    async (request, reply) => {
      if (!context.ktvIndexRawAssets || !context.mediaPathResolver) {
        return reply.status(503).send({ error: "KTV_INDEX_RAW_MEDIA_UNAVAILABLE" });
      }

      const row = await context.ktvIndexRawAssets.findRawAssetById(request.params.indexedAssetId);
      if (!row) {
        return reply.status(404).send({ error: "KTV_INDEX_ASSET_NOT_FOUND" });
      }
      if (!row.karaokeLyricFile) {
        return reply.status(404).send({ error: "KARAOKE_NOT_FOUND" });
      }

      const resolved = await context.mediaPathResolver.resolveAssetFile(row.karaokeLyricFile);
      if (!resolved.ok) {
        return sendRawMediaPathError(reply, resolved);
      }

      try {
        const content = await readFile(resolved.filePath, "utf8");
        return reply
          .type("application/json; charset=utf-8")
          .header("cache-control", "no-store")
          .send(content);
      } catch {
        return reply.status(404).send({ error: "KARAOKE_NOT_FOUND" });
      }
    }
  );

  // 为 lyrics 阶段失败/LRCLIB 未命中的歌(多为在线补歌产物)单独重查歌词并落库,
  // 不重跑下载/伴奏/对齐等其他阶段。文件名按 "歌手-歌名-语种-分类" 反查 LRCLIB
  // (原文→简体变体),命中写 <stem>.lrc 到 mkv 旁并 UPDATE lyric_file。
  // LRCLIB 未命中且配置了 ASR 服务时,改为从 MV 音频转写歌词(带时间戳,天然同步)。
  fastify.post<{ Params: { assetId: string } }>(
    "/media/ktv-index/:assetId/regenerate-lyrics",
    async (request, reply) => {
      if (!context.ktvIndexRawAssets || !context.mediaPathResolver) {
        return reply.status(503).send({ error: "KTV_INDEX_RAW_MEDIA_UNAVAILABLE" });
      }

      const row = await context.ktvIndexRawAssets.findRawAssetById(request.params.assetId);
      if (!row) {
        return reply.status(404).send({ error: "KTV_INDEX_ASSET_NOT_FOUND" });
      }

      const stem = basename(row.filePath, extname(row.filePath));
      const names = artistTrackFromStem(stem);
      if (!names) {
        return reply.status(422).send({ error: "UNPARSABLE_FILENAME" });
      }

      let matched: Awaited<ReturnType<typeof fetchBestLrclibWithVariants>>;
      try {
        matched = await fetchBestLrclibWithVariants({
          artistName: names.artistName,
          trackName: names.trackName,
          baseUrl: context.lrclibBaseUrl?.trim() || defaultLrclibBaseUrl,
          ...(context.lyricsFetchImpl ? { fetchImpl: context.lyricsFetchImpl } : {})
        });
      } catch (error) {
        context.log?.warn({ error, assetId: request.params.assetId }, "regenerate-lyrics lrclib error");
        return reply.status(502).send({ error: "LYRICS_PROVIDER_UNAVAILABLE" });
      }

      const synced = matched?.record.syncedLyrics?.trim();
      if (!synced) {
        return transcribeLyricsWithAsr(
          reply,
          {
            asrBaseUrl: context.asrBaseUrl,
            asrModel: context.asrModel,
            asrAudioExtractor: context.asrAudioExtractor,
            asrTranscriber: context.asrTranscriber,
            ffmpegBin: context.ffmpegBin,
            ...(context.log ? { log: context.log } : {}),
            ktvIndexRawAssets: context.ktvIndexRawAssets,
            mediaPathResolver: context.mediaPathResolver
          },
          {
            assetId: request.params.assetId,
            row,
            stem,
            artistName: names.artistName,
            trackName: names.trackName
          }
        );
      }

      // 写到 mkv 同目录:落盘用 mediaPathResolver 解析出的本机路径,库里存
      // 与 file_path 同风格的原始路径(读取时同样过 resolver,与回填脚本一致)。
      const resolved = await context.mediaPathResolver.resolveAssetFile(row.filePath);
      if (!resolved.ok) {
        return sendRawMediaPathError(reply, resolved);
      }

      const lyricPath = join(dirname(row.filePath), `${stem}.lrc`);
      try {
        await writeFile(join(dirname(resolved.filePath), `${stem}.lrc`), `${synced}\n`, "utf8");
      } catch (error) {
        context.log?.warn({ error, lyricPath }, "regenerate-lyrics write failed");
        return reply.status(500).send({ error: "LYRIC_WRITE_FAILED" });
      }

      await context.ktvIndexRawAssets.updateLyricFile(row.id, lyricPath);
      return reply.status(200).send({ status: "found", lyricFile: lyricPath });
    }
  );

  fastify.get<{ Params: { assetId: string }; Querystring: { audio?: unknown; start?: unknown; offsetProbe?: unknown } }>(
    "/media/nas/:assetId",
    async (request, reply) => {
      if (!context.mediaGateway) {
        return reply.status(503).send({ error: "MEDIA_GATEWAY_UNAVAILABLE" });
      }

      const audioTrackPos = parseNonNegativeInt(request.query.audio);
      const startMs = parseNonNegativeInt(request.query.start);

    const resolution = await context.mediaGateway.resolveForStreaming({
      sourceType: "nas",
      assetId: request.params.assetId
    });
    if (!resolution.ok) {
      return sendSourceMediaError(reply, resolution);
    }

    if (audioTrackPos !== null) {
      // 偏移探测请求(offsetProbe=1):只算 remux 流的 start 提前量并立即返回,
      // 不启动 ffmpeg(客户端拿小 JSON 后再正常拉流,流式路径零额外延迟)。
      if (parseBooleanQueryFlag(request.query.offsetProbe)) {
        return sendRemuxStartOffsetProbe(reply, {
          filePath: resolution.filePath,
          startMs: startMs ?? 0,
          ffprobeBin: context.ffprobeBin ?? defaultFfprobeBinFor(context.ffmpegBin ?? "ffmpeg"),
          prober: context.remuxStartOffsetProber ?? probeRemuxStartOffsetWithFfprobe,
          ...(context.log ? { log: context.log } : {})
        });
      }
      return sendRemuxedAudioTrackStream(reply, request.raw, {
        filePath: resolution.filePath,
        audioTrackPos,
        startMs: startMs ?? 0,
        ffmpegBin: context.ffmpegBin ?? "ffmpeg",
        ...(context.log ? { log: context.log } : {})
      });
    }

    return sendResolvedMedia(reply, {
      filePath: resolution.filePath,
      contentLength: resolution.contentLength,
      contentType: resolution.contentType,
      rangeHeader: request.headers.range
    });
  });

  fastify.get<{ Params: { assetId: string } }>("/media/online/:assetId", async (request, reply) => {
    if (!context.mediaGateway) {
      return reply.status(503).send({ error: "MEDIA_GATEWAY_UNAVAILABLE" });
    }

    const resolution = await context.mediaGateway.resolveForStreaming({
      sourceType: "online",
      assetId: request.params.assetId
    });
    if (!resolution.ok) {
      return sendSourceMediaError(reply, resolution);
    }

    return sendResolvedMedia(reply, {
      filePath: resolution.filePath,
      contentLength: resolution.contentLength,
      contentType: resolution.contentType,
      rangeHeader: request.headers.range
    });
  });
}

function parseNasCoverSongId(coverFileName: string): string | null {
  if (!safeNasCoverFileName.test(coverFileName)) {
    return null;
  }
  return coverFileName.slice(0, -".jpg".length);
}

// transcribeLyricsWithAsr 需要的字段(ktvIndexRawAssets/mediaPathResolver 已在路由
// 开头判过非空;可选字段显式收 undefined,配合 exactOptionalPropertyTypes 直接透传)。
interface MediaAsrRouteContext {
  asrBaseUrl?: string | undefined;
  asrModel?: string | undefined;
  asrAudioExtractor?: AsrAudioExtractor | undefined;
  asrTranscriber?: AsrTranscriber | undefined;
  ffmpegBin?: string | undefined;
  log?: FastifyBaseLogger | undefined;
  ktvIndexRawAssets: KtvIndexRawAssetRepository;
  mediaPathResolver: MediaPathResolver;
}

// LRCLIB 未命中后的 ASR 转写回退:mkv 抽成 16kHz mono 音频 → 转写(带时间戳) →
// 拼 LRC 落库。segments 有时间戳 → transcribed(写 <stem>.lrc + UPDATE lyric_file);
// 只有纯文本无时间轴 → transcribed_no_timing(不落库,仅提示);连文本都没有 →
// 视同 not_found;ASR 网络/HTTP 失败 → 502 ASR_UNAVAILABLE。
async function transcribeLyricsWithAsr(
  reply: FastifyReply,
  context: MediaAsrRouteContext,
  input: {
    assetId: string;
    row: KtvIndexRawAssetRow;
    stem: string;
    artistName: string;
    trackName: string;
  }
): Promise<FastifyReply> {
  const asrBaseUrl = context.asrBaseUrl?.trim();
  if (!asrBaseUrl) {
    return reply.status(200).send({ status: "not_found" });
  }

  const resolved = await context.mediaPathResolver.resolveAssetFile(input.row.filePath);
  if (!resolved.ok) {
    return sendRawMediaPathError(reply, resolved);
  }

  const tempDir = await mkdtemp(join(tmpdir(), "home-ktv-asr-"));
  try {
    const audioPath = join(tempDir, "audio.m4a");
    const extractAudio = context.asrAudioExtractor ?? extractMonoAudioWithFfmpeg;
    try {
      await extractAudio({
        ffmpegBin: context.ffmpegBin ?? "ffmpeg",
        filePath: resolved.filePath,
        outputPath: audioPath
      });
    } catch (error) {
      context.log?.warn({ error, assetId: input.assetId }, "regenerate-lyrics ffmpeg extract failed");
      return reply.status(500).send({ error: "AUDIO_EXTRACT_FAILED" });
    }

    const transcriber: AsrTranscriber = context.asrTranscriber ?? transcribeAudio;
    let transcription: Awaited<ReturnType<AsrTranscriber>>;
    try {
      transcription = await transcriber({
        baseUrl: asrBaseUrl,
        model: context.asrModel?.trim() || DEFAULT_ASR_MODEL,
        filePath: audioPath,
        prompt: `这是${input.artistName}演唱的歌曲《${input.trackName}》，请转写歌词文本`
      });
    } catch (error) {
      context.log?.warn({ error, assetId: input.assetId }, "regenerate-lyrics asr error");
      return reply.status(502).send({ error: "ASR_UNAVAILABLE" });
    }

    const lines = buildLrcLinesFromSegments(transcription.segments);
    if (lines.length === 0) {
      if (transcription.text.trim()) {
        return reply.status(200).send({ status: "transcribed_no_timing" });
      }
      return reply.status(200).send({ status: "not_found" });
    }

    // 与 LRCLIB 命中分支同一套落盘/回写策略:本机路径写文件,库里存原始风格路径。
    const lyricPath = join(dirname(input.row.filePath), `${input.stem}.lrc`);
    try {
      await writeFile(join(dirname(resolved.filePath), `${input.stem}.lrc`), `${lines.join("\n")}\n`, "utf8");
    } catch (error) {
      context.log?.warn({ error, lyricPath }, "regenerate-lyrics write failed");
      return reply.status(500).send({ error: "LYRIC_WRITE_FAILED" });
    }

    await context.ktvIndexRawAssets.updateLyricFile(input.row.id, lyricPath);
    return reply.status(200).send({ status: "transcribed", lyricFile: lyricPath });
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// mkv → 16kHz mono m4a(ASR 输入):丢视频轨、混单声道、重采样,大幅减小上传体积。
async function extractMonoAudioWithFfmpeg(input: {
  ffmpegBin: string;
  filePath: string;
  outputPath: string;
}): Promise<void> {
  await execFileAsync(
    input.ffmpegBin,
    ["-y", "-nostdin", "-i", input.filePath, "-vn", "-ac", "1", "-ar", "16000", input.outputPath],
    { timeout: 120_000, windowsHide: true }
  );
}

// whisper 风格 segments → LRC 行:按 start 排序,过滤纯空白/纯符号段
// (与 python/align_lyrics.py 的 isalnum 规则一致:无字母数字的行不保留)。
function buildLrcLinesFromSegments(segments: readonly AsrSegment[]): string[] {
  return [...segments]
    .sort((a, b) => a.start - b.start)
    .map((segment) => ({ start: segment.start, text: segment.text.trim() }))
    .filter((segment) => Number.isFinite(segment.start) && /[\p{L}\p{N}]/u.test(segment.text))
    .map((segment) => `[${formatLrcTimestamp(segment.start)}]${segment.text}`);
}

// 秒 → "[mm:ss.xx]"(两位分钟、两位小数秒,与 LRCLIB/align 脚本同风格)。
function formatLrcTimestamp(seconds: number): string {
  const clamped = Math.max(seconds, 0);
  const minutes = Math.floor(clamped / 60);
  const rest = clamped - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(2).padStart(5, "0")}`;
}

function parseNonNegativeInt(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

// 浏览器(Chromium)不支持单文件音轨切换时,服务端用 ffmpeg 选轨 remux(codec copy,
// 非转码)输出只含目标音轨的 matroska 流;startMs 让流直接从切换点开始,规避 pipe
// 流不支持 Range seek 的问题。客户端断开时杀掉 ffmpeg 进程。
function sendRemuxedAudioTrackStream(
  reply: FastifyReply,
  rawRequest: { on: (event: string, listener: () => void) => void },
  input: {
    filePath: string;
    audioTrackPos: number;
    startMs: number;
    ffmpegBin: string;
    log?: FastifyBaseLogger;
  }
): FastifyReply {
  const startSeconds = input.startMs / 1000;
  const args = [
    "-nostdin",
    ...(input.startMs > 0 ? ["-ss", startSeconds.toFixed(3)] : []),
    "-i",
    input.filePath,
    "-map",
    "0:v:0",
    "-map",
    `0:a:${input.audioTrackPos}`,
    "-c",
    "copy",
    "-f",
    "matroska",
    "-avoid_negative_ts",
    "make_zero",
    "pipe:1"
  ];

  const child = spawn(input.ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"] });
  const stderrChunks: Buffer[] = [];
  let headersSent = false;

  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderrChunks.length < 20) {
      stderrChunks.push(chunk);
    }
  });
  child.on("error", (error) => {
    input.log?.error({ error, filePath: input.filePath }, "audio-track remux spawn failed");
    if (!headersSent) {
      headersSent = true;
      void reply.status(500).send({ error: "MEDIA_REMUX_SPAWN_FAILED" });
    } else {
      child.stdout.destroy(error);
    }
  });
  child.on("close", (code) => {
    if (code !== 0 && !headersSent) {
      const stderr = Buffer.concat(stderrChunks).toString("utf8").slice(-400);
      input.log?.warn({ code, stderr, filePath: input.filePath }, "audio-track remux exited non-zero");
      headersSent = true;
      void reply.status(500).send({ error: "MEDIA_REMUX_FAILED" });
    }
  });

  rawRequest.on("close", () => {
    child.kill();
  });

  reply.header("cache-control", "no-store");
  child.stdout.once("readable", () => {
    if (!headersSent) {
      headersSent = true;
      reply.type("video/x-matroska");
      void reply.send(child.stdout);
    }
  });
  return reply;
}

// -c copy 下 -ss 的视频流会回退到 start 前最近的 keyframe(可达一个 GOP 数秒),
// -avoid_negative_ts make_zero 再把所有流平移到最早包 t=0:流内音频要等到
// (start - keyframe 时刻) 才真正开始。客户端若仍按"流 t=0 = 请求 start"计算
// 进度会超前真实进度一个 GOP 内的提前量(切伴唱瞬间歌词高亮错位)。探测只读源
// 文件 start 前 keyframe 窗口的包时间戳,算出提前量供客户端从位置基准扣除;
// 探测失败(无 ffprobe/无 keyframe/超时)返回 null,客户端维持现状行为。
const remuxProbeWindowSeconds = 20;
const remuxProbeTimeoutMs = 4000;
const remuxProbeMaxBufferBytes = 8 * 1024 * 1024;

async function sendRemuxStartOffsetProbe(
  reply: FastifyReply,
  input: {
    filePath: string;
    startMs: number;
    ffprobeBin: string;
    prober: RemuxStartOffsetProber;
    log?: FastifyBaseLogger;
  }
): Promise<FastifyReply> {
  let startOffsetMs: number | null = null;
  try {
    startOffsetMs = await input.prober({
      ffprobeBin: input.ffprobeBin,
      filePath: input.filePath,
      startMs: input.startMs
    });
  } catch (error) {
    input.log?.warn({ error, filePath: input.filePath }, "audio-track remux start-offset probe failed");
  }

  const normalizedOffsetMs =
    typeof startOffsetMs === "number" && Number.isFinite(startOffsetMs) && startOffsetMs >= 0
      ? Math.trunc(startOffsetMs)
      : null;

  reply.header("cache-control", "no-store");
  if (normalizedOffsetMs !== null && normalizedOffsetMs > 0) {
    reply.header("x-ktv-start-offset-ms", String(normalizedOffsetMs));
  }
  return reply.status(200).send({ startOffsetMs: normalizedOffsetMs });
}

export async function probeRemuxStartOffsetWithFfprobe(input: {
  ffprobeBin: string;
  filePath: string;
  startMs: number;
}): Promise<number | null> {
  const startSeconds = Math.max(0, input.startMs) / 1000;
  const windowStartSeconds = Math.max(0, startSeconds - remuxProbeWindowSeconds);
  const readDurationSeconds = startSeconds - windowStartSeconds + 1;
  const { stdout } = await execFileAsync(
    input.ffprobeBin,
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "packet=pts_time,flags",
      "-of",
      "json",
      "-read_intervals",
      `${windowStartSeconds.toFixed(3)}%+${readDurationSeconds.toFixed(3)}`,
      input.filePath
    ],
    { timeout: remuxProbeTimeoutMs, windowsHide: true, maxBuffer: remuxProbeMaxBufferBytes }
  );
  return startOffsetMsFromProbeOutput(stdout, input.startMs);
}

// ffprobe -show_packets(json) → start 前最近视频 keyframe 相对 start 的提前量(ms)。
// 只认 pts 有效且 ≤ start、带 K flag 的包;窗口内没有 keyframe 或 JSON 不可解析 → null。
export function startOffsetMsFromProbeOutput(stdout: string, startMs: number): number | null {
  let packets: unknown;
  try {
    packets = (JSON.parse(stdout) as { packets?: unknown }).packets;
  } catch {
    return null;
  }
  if (!Array.isArray(packets)) {
    return null;
  }

  const startSeconds = Math.max(0, startMs) / 1000;
  let lastKeyframeSeconds = -1;
  for (const entry of packets) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const ptsSeconds = Number((entry as { pts_time?: unknown }).pts_time);
    if (!Number.isFinite(ptsSeconds) || ptsSeconds < 0 || ptsSeconds > startSeconds + 0.001) {
      continue;
    }
    const flags = String((entry as { flags?: unknown }).flags ?? "");
    if (!flags.includes("K") || ptsSeconds <= lastKeyframeSeconds) {
      continue;
    }
    lastKeyframeSeconds = ptsSeconds;
  }

  if (lastKeyframeSeconds < 0) {
    return null;
  }
  return Math.max(0, Math.round((startSeconds - lastKeyframeSeconds) * 1000));
}

// ffmpegBin 同目录推导 ffprobe(自定义 ffmpeg 路径时不再依赖 PATH);推导不出则退回 PATH 上的 ffprobe。
function defaultFfprobeBinFor(ffmpegBin: string): string {
  const match = /^(.*)ffmpeg(\.exe)?$/iu.exec(ffmpegBin);
  return match ? `${match[1]}ffprobe${match[2] ?? ""}` : "ffprobe";
}

function parseBooleanQueryFlag(value: unknown): boolean {
  return value === true || value === "1" || value === "true";
}

async function sendNasCoverImage(
  reply: FastifyReply,
  input: { filePath: string; rangeHeader: string | undefined }
): Promise<FastifyReply> {
  let coverStat: Awaited<ReturnType<typeof stat>>;
  try {
    coverStat = await stat(input.filePath);
  } catch {
    return reply.status(404).send({ error: "SONG_COVER_NOT_FOUND" });
  }

  if (!coverStat.isFile()) {
    return reply.status(404).send({ error: "SONG_COVER_NOT_FOUND" });
  }

  return sendResolvedMedia(reply, {
    filePath: input.filePath,
    contentLength: coverStat.size,
    contentType: await inferCoverImageContentType(input.filePath),
    rangeHeader: input.rangeHeader,
    cacheControl: "public, max-age=2592000, immutable"
  });
}

async function inferCoverImageContentType(filePath: string): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(12);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return inferCoverImageContentTypeFromBytes(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

function inferCoverImageContentTypeFromBytes(bytes: Buffer): string {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return "image/jpeg";
  }
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.subarray(0, 4).equals(Buffer.from("RIFF")) && bytes.subarray(8, 12).equals(Buffer.from("WEBP"))) {
    return "image/webp";
  }
  if (bytes.subarray(0, 6).equals(Buffer.from("GIF87a")) || bytes.subarray(0, 6).equals(Buffer.from("GIF89a"))) {
    return "image/gif";
  }
  return "image/jpeg";
}

export interface KtvIndexRawAssetRow {
  id: string;
  filePath: string;
  lyricFile: string | null;
  karaokeLyricFile: string | null;
}

export interface KtvIndexRawAssetRepository {
  findRawAssetById(indexedAssetId: string): Promise<KtvIndexRawAssetRow | null>;
  /** regenerate-lyrics 命中后回写 lyric_file 并刷新 updated_at */
  updateLyricFile(indexedAssetId: string, lyricFile: string): Promise<void>;
}

export class PgKtvIndexRawAssetRepository implements KtvIndexRawAssetRepository {
  constructor(private readonly db: QueryExecutor) {}

  async findRawAssetById(indexedAssetId: string): Promise<KtvIndexRawAssetRow | null> {
    const result = await this.db.query<KtvIndexRawAssetRow>(
      `SELECT id, file_path AS "filePath", lyric_file AS "lyricFile", karaoke_lyrics_file AS "karaokeLyricFile"
       FROM ktv_songs
       WHERE id = $1 AND missing_at IS NULL
       LIMIT 1`,
      [indexedAssetId]
    );
    return result.rows[0] ?? null;
  }

  async updateLyricFile(indexedAssetId: string, lyricFile: string): Promise<void> {
    await this.db.query(
      `UPDATE ktv_songs SET lyric_file = $1, updated_at = now() WHERE id = $2`,
      [lyricFile, indexedAssetId]
    );
  }
}

function sendSourceMediaError(
  reply: FastifyReply,
  resolution: Extract<MediaGatewayResolution, { ok: false }>
): FastifyReply {
  return reply.status(resolution.statusCode).send({
    error: resolution.code
  });
}

function sendRawMediaPathError(
  reply: FastifyReply,
  resolution: Extract<MediaPathResolution, { ok: false }>
): FastifyReply {
  switch (resolution.reason) {
    case "media-root-not-configured":
      return reply.status(503).send({ error: "MEDIA_ROOT_NOT_CONFIGURED" });
    case "path-outside-media-root":
      return reply.status(500).send({ error: "MEDIA_PATH_REJECTED" });
    case "file-not-found":
    case "not-a-file":
      return reply.status(404).send({ error: "MEDIA_FILE_NOT_FOUND" });
  }
}

function sendResolvedMedia(
  reply: FastifyReply,
  input: {
    filePath: string;
    contentLength: number;
    contentType: string;
    rangeHeader: string | undefined;
    cacheControl?: string;
  }
) {
  const byteRange = parseByteRange(input.rangeHeader, input.contentLength);
  if (byteRange === "invalid") {
    return reply
      .status(416)
      .header("content-range", `bytes */${input.contentLength}`)
      .send({ error: "MEDIA_RANGE_NOT_SATISFIABLE" });
  }

  reply.type(input.contentType);
  reply.header("accept-ranges", "bytes");
  if (input.cacheControl) {
    reply.header("cache-control", input.cacheControl);
  }

  if (byteRange) {
    const contentLength = byteRange.end - byteRange.start + 1;
    reply.status(206);
    reply.header("content-range", `bytes ${byteRange.start}-${byteRange.end}/${input.contentLength}`);
    reply.header("content-length", contentLength);
    return reply.send(createReadStream(input.filePath, byteRange));
  }

  reply.header("content-length", input.contentLength);
  return reply.send(createReadStream(input.filePath));
}

type ByteRange = { start: number; end: number };

function parseByteRange(rangeHeader: string | undefined, fileSize: number): ByteRange | "invalid" | null {
  if (!rangeHeader) {
    return null;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) {
    return "invalid";
  }

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") {
    return "invalid";
  }

  if (rawStart === "") {
    const suffixLength = Number.parseInt(rawEnd ?? "", 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return "invalid";
    }

    return {
      start: Math.max(fileSize - suffixLength, 0),
      end: fileSize - 1
    };
  }

  const start = Number.parseInt(rawStart ?? "", 10);
  const requestedEnd = rawEnd === "" ? fileSize - 1 : Number.parseInt(rawEnd ?? "", 10);
  if (!Number.isFinite(start) || !Number.isFinite(requestedEnd) || start < 0 || requestedEnd < start || start >= fileSize) {
    return "invalid";
  }

  return {
    start,
    end: Math.min(requestedEnd, fileSize - 1)
  };
}
