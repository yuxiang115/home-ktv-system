import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from "fastify";
import { inferVideoContentType } from "../modules/media/content-type.js";
import type { MediaPathResolver, MediaPathResolution } from "../modules/assets/media-path-resolver.js";
import type { QueryExecutor } from "../db/query-executor.js";
import type { MediaGateway, MediaGatewayResolution } from "../modules/media/media-gateway.js";

const safeNasCoverFileName = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.jpg$/u;

export interface MediaRouteContext {
  coverRoot?: string;
  mediaGateway?: Pick<MediaGateway, "resolveForStreaming">;
  ktvIndexRawAssets?: KtvIndexRawAssetRepository;
  mediaPathResolver?: MediaPathResolver;
  /** remux 选轨流(切伴奏 fallback)用的 ffmpeg;缺省为 PATH 上的 ffmpeg */
  ffmpegBin?: string;
  log?: FastifyBaseLogger;
}

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

  fastify.get<{ Params: { assetId: string }; Querystring: { audio?: unknown; start?: unknown } }>(
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
}

export interface KtvIndexRawAssetRepository {
  findRawAssetById(indexedAssetId: string): Promise<KtvIndexRawAssetRow | null>;
}

export class PgKtvIndexRawAssetRepository implements KtvIndexRawAssetRepository {
  constructor(private readonly db: QueryExecutor) {}

  async findRawAssetById(indexedAssetId: string): Promise<KtvIndexRawAssetRow | null> {
    const result = await this.db.query<KtvIndexRawAssetRow>(
      `SELECT id, file_path AS "filePath"
       FROM ktv_songs
       WHERE id = $1 AND missing_at IS NULL
       LIMIT 1`,
      [indexedAssetId]
    );
    return result.rows[0] ?? null;
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
