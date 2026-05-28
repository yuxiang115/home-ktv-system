import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Fastify from "fastify";
import type { PlayableMediaAsset, PlayableMediaLookup, PlayableMediaRepository } from "../modules/media/playable-media-repository.js";
import { MediaPathResolver } from "../modules/assets/media-path-resolver.js";
import { MediaGateway } from "../modules/media/media-gateway.js";
import { registerMediaRoutes } from "../routes/media.js";
import { describe, expect, it } from "vitest";

describe("NAS media route", () => {
  it("streams NAS media through /media/nas/:assetId with range support", async () => {
    const mediaRoot = await mkdtemp(join(tmpdir(), "home-ktv-nas-media-"));
    const mediaPath = join(mediaRoot, "sample.mkv");
    await writeFile(mediaPath, Buffer.from("0123456789"));
    const server = Fastify();
    const mediaGateway = new MediaGateway({
      playableMedia: new FakePlayableMediaRepository(createPlayableAsset({ assetId: "ktv-asset-1", filePath: mediaPath })),
      mediaPathResolver: new MediaPathResolver({ mediaRoot }),
      publicBaseUrl: "http://ktv.local"
    });

    await registerMediaRoutes(server, {
      assetGateway: createMissingAssetGateway(),
      mediaGateway
    });

    const response = await server.inject({
      method: "GET",
      url: "/media/nas/ktv-asset-1",
      headers: {
        range: "bytes=2-5"
      }
    });

    expect(mediaGateway.createPlaybackUrl({ sourceType: "nas", assetId: "ktv-asset-1" })).toBe(
      "http://ktv.local/media/nas/ktv-asset-1"
    );
    expect(response.statusCode).toBe(206);
    expect(response.headers["content-type"]).toContain("video/x-matroska");
    expect(response.headers["content-range"]).toBe("bytes 2-5/10");
    expect(response.body).toBe("2345");
  });

  it("rejects non-ready NAS media before touching the filesystem", async () => {
    const server = Fastify();
    const mediaGateway = new MediaGateway({
      playableMedia: new FakePlayableMediaRepository(createPlayableAsset({ status: "unavailable" })),
      mediaPathResolver: new MediaPathResolver({ mediaRoot: "/does-not-matter" }),
      publicBaseUrl: ""
    });

    await registerMediaRoutes(server, {
      assetGateway: createMissingAssetGateway(),
      mediaGateway
    });

    const response = await server.inject({
      method: "GET",
      url: "/media/nas/ktv-asset-1"
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "MEDIA_SOURCE_NOT_READY" });
  });
});

function createMissingAssetGateway() {
  return {
    async resolveForStreaming() {
      return { ok: false as const, statusCode: 404 as const, code: "ASSET_NOT_FOUND" as const };
    }
  };
}

class FakePlayableMediaRepository implements PlayableMediaRepository {
  constructor(private readonly asset: PlayableMediaAsset | null) {}

  async findPlayableBySource(source: PlayableMediaLookup): Promise<PlayableMediaAsset | null> {
    return this.asset?.sourceType === source.sourceType && this.asset.assetId === source.assetId ? this.asset : null;
  }
}

function createPlayableAsset(overrides: Partial<PlayableMediaAsset> = {}): PlayableMediaAsset {
  return {
    sourceType: "nas",
    songId: "ktv-song-1",
    assetId: "ktv-asset-1",
    title: "晴天",
    artistName: "周杰伦",
    displayName: "晴天.mkv",
    filePath: "/nas/晴天.mkv",
    status: "ready",
    durationMs: 241000,
    compatibilityStatus: "playable",
    compatibilityReasons: [],
    mediaInfoSummary: {
      container: "matroska,webm",
      durationMs: 241000,
      videoCodec: "h264",
      resolution: null,
      fileSizeBytes: 10,
      audioTracks: [{ index: 0, id: "0x1100", label: "Original", language: null, codec: "aac", channels: 2 }]
    },
    mediaInfoProvenance: {
      source: "ffprobe",
      sourceVersion: null,
      probedAt: null,
      importedFrom: null
    },
    trackRoles: {
      original: { index: 0, id: "0x1100", label: "Original" },
      instrumental: null
    },
    playbackProfile: {
      kind: "single_file_audio_tracks",
      container: "matroska,webm",
      videoCodec: "h264",
      audioCodecs: ["aac"],
      requiresAudioTrackSelection: false
    },
    ...overrides
  };
}
