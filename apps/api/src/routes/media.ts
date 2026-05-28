import { createReadStream } from "node:fs";
import type { FastifyInstance, FastifyReply } from "fastify";
import { inferVideoContentType } from "../modules/media/content-type.js";
import type { MediaPathResolver, MediaPathResolution } from "../modules/assets/media-path-resolver.js";
import type { QueryExecutor } from "../db/query-executor.js";
import type { MediaGateway, MediaGatewayResolution } from "../modules/media/media-gateway.js";

export interface MediaRouteContext {
  mediaGateway?: Pick<MediaGateway, "resolveForStreaming">;
  ktvIndexRawAssets?: KtvIndexRawAssetRepository;
  mediaPathResolver?: MediaPathResolver;
}

export async function registerMediaRoutes(fastify: FastifyInstance, context: MediaRouteContext): Promise<void> {
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

  fastify.get<{ Params: { assetId: string } }>("/media/nas/:assetId", async (request, reply) => {
    if (!context.mediaGateway) {
      return reply.status(503).send({ error: "MEDIA_GATEWAY_UNAVAILABLE" });
    }

    const resolution = await context.mediaGateway.resolveForStreaming({
      sourceType: "nas",
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
       FROM ktv_song_assets
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
