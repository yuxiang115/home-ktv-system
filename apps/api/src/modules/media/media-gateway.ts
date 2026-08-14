import type { AssetId, SongSourceType } from "@home-ktv/domain";
import { inferVideoContentType } from "./content-type.js";
import type { MediaPathResolution, MediaPathResolver } from "../assets/media-path-resolver.js";
import type { PlayableMediaLookup, PlayableMediaRepository } from "./playable-media-repository.js";

export type MediaGatewayResolution =
  | {
      ok: true;
      sourceType: SongSourceType;
      assetId: AssetId;
      filePath: string;
      contentLength: number;
      contentType: string;
    }
  | {
      ok: false;
      statusCode: 404 | 409 | 500 | 501 | 503;
      code:
        | "MEDIA_SOURCE_NOT_FOUND"
        | "MEDIA_SOURCE_NOT_READY"
        | "MEDIA_ROOT_NOT_CONFIGURED"
        | "MEDIA_PATH_REJECTED"
        | "MEDIA_FILE_NOT_FOUND"
        | "ONLINE_PLAYBACK_NOT_IMPLEMENTED";
    };

export interface MediaGatewayOptions {
  playableMedia: PlayableMediaRepository;
  mediaPathResolver: MediaPathResolver;
  publicBaseUrl: string;
}

export interface MediaGatewayPlaybackUrlOptions {
  /** 目标音频轨序号(0-based,按 technical_metadata.audioTracks 数组下标);stream remux 选轨用 */
  audioTrackPos?: number;
  /** 起播位置(毫秒),remux 流从该点开始输出 */
  startMs?: number;
}

export class MediaGateway {
  constructor(private readonly options: MediaGatewayOptions) {}

  createPlaybackUrl(source: PlayableMediaLookup, urlOptions?: MediaGatewayPlaybackUrlOptions): string {
    const path = `/media/${encodeURIComponent(source.sourceType)}/${encodeURIComponent(source.assetId)}`;
    const baseUrl = this.options.publicBaseUrl.trim().replace(/\/$/, "");
    const params = new URLSearchParams();
    if (typeof urlOptions?.audioTrackPos === "number" && Number.isFinite(urlOptions.audioTrackPos) && urlOptions.audioTrackPos >= 0) {
      params.set("audio", String(Math.trunc(urlOptions.audioTrackPos)));
    }
    if (typeof urlOptions?.startMs === "number" && Number.isFinite(urlOptions.startMs) && urlOptions.startMs > 0) {
      params.set("start", String(Math.trunc(urlOptions.startMs)));
    }
    const query = params.size > 0 ? `?${params.toString()}` : "";
    return baseUrl ? `${baseUrl}${path}${query}` : `${path}${query}`;
  }

  async resolveForStreaming(source: PlayableMediaLookup): Promise<MediaGatewayResolution> {
    if (source.sourceType === "online") {
      return { ok: false, statusCode: 501, code: "ONLINE_PLAYBACK_NOT_IMPLEMENTED" };
    }

    const asset = await this.options.playableMedia.findPlayableBySource(source);
    if (!asset) {
      return { ok: false, statusCode: 404, code: "MEDIA_SOURCE_NOT_FOUND" };
    }

    if (asset.status !== "ready") {
      return { ok: false, statusCode: 409, code: "MEDIA_SOURCE_NOT_READY" };
    }

    const resolved = await this.options.mediaPathResolver.resolveAssetFile(asset.filePath);
    if (!resolved.ok) {
      return this.mapPathResolutionFailure(resolved);
    }

    return {
      ok: true,
      sourceType: asset.sourceType,
      assetId: asset.assetId,
      filePath: resolved.filePath,
      contentLength: resolved.sizeBytes,
      contentType: inferVideoContentType(asset.filePath)
    };
  }

  private mapPathResolutionFailure(resolved: Extract<MediaPathResolution, { ok: false }>): MediaGatewayResolution {
    switch (resolved.reason) {
      case "media-root-not-configured":
        return { ok: false, statusCode: 503, code: "MEDIA_ROOT_NOT_CONFIGURED" };
      case "path-outside-media-root":
        return { ok: false, statusCode: 500, code: "MEDIA_PATH_REJECTED" };
      case "file-not-found":
      case "not-a-file":
        return { ok: false, statusCode: 404, code: "MEDIA_FILE_NOT_FOUND" };
    }
  }
}
