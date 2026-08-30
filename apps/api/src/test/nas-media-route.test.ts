import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Fastify, { type FastifyInstance } from "fastify";
import type { PlayableMediaAsset, PlayableMediaLookup, PlayableMediaRepository } from "../modules/media/playable-media-repository.js";
import { MediaPathResolver } from "../modules/assets/media-path-resolver.js";
import { MediaGateway } from "../modules/media/media-gateway.js";
import { registerMediaRoutes, startOffsetMsFromProbeOutput, type RemuxStartOffsetProber } from "../routes/media.js";
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

describe("NAS remux audio-track start offset probe", () => {
  it("returns the probed keyframe lead as header and json without spawning ffmpeg", async () => {
    const { mediaRoot, mediaPath } = await createNasMediaRoot();
    const proberCalls: Array<Parameters<RemuxStartOffsetProber>[0]> = [];
    const server = Fastify();
    const mediaGateway = new MediaGateway({
      playableMedia: new FakePlayableMediaRepository(createPlayableAsset({ assetId: "ktv-asset-1", filePath: mediaPath })),
      mediaPathResolver: new MediaPathResolver({ mediaRoot }),
      publicBaseUrl: "http://ktv.local"
    });

    await registerMediaRoutes(server, {
      mediaGateway,
      ffprobeBin: "ffprobe-custom",
      remuxStartOffsetProber: async (input) => {
        proberCalls.push(input);
        return 4830.6;
      }
    });

    const response = await server.inject({
      method: "GET",
      url: "/media/nas/ktv-asset-1?audio=1&start=82400&offsetProbe=1"
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-ktv-start-offset-ms"]).toBe("4830");
    expect(response.json()).toEqual({ startOffsetMs: 4830 });
    expect(proberCalls).toEqual([{ ffprobeBin: "ffprobe-custom", filePath: mediaPath, startMs: 82400 }]);
  });

  it("omits the header and reports null when the prober fails or finds nothing", async () => {
    const { mediaRoot, mediaPath } = await createNasMediaRoot();
    const server = Fastify();
    const mediaGateway = new MediaGateway({
      playableMedia: new FakePlayableMediaRepository(createPlayableAsset({ assetId: "ktv-asset-1", filePath: mediaPath })),
      mediaPathResolver: new MediaPathResolver({ mediaRoot }),
      publicBaseUrl: "http://ktv.local"
    });

    await registerMediaRoutes(server, {
      mediaGateway,
      remuxStartOffsetProber: async () => {
        throw new Error("ffprobe missing");
      }
    });

    const nullProbeServer = Fastify();
    await registerMediaRoutes(nullProbeServer, {
      mediaGateway: new MediaGateway({
        playableMedia: new FakePlayableMediaRepository(createPlayableAsset({ assetId: "ktv-asset-1", filePath: mediaPath })),
        mediaPathResolver: new MediaPathResolver({ mediaRoot }),
        publicBaseUrl: "http://ktv.local"
      }),
      remuxStartOffsetProber: async () => null
    });

    const failedResponse = await server.inject({
      method: "GET",
      url: "/media/nas/ktv-asset-1?audio=1&start=82400&offsetProbe=1"
    });
    const nullResponse = await nullProbeServer.inject({
      method: "GET",
      url: "/media/nas/ktv-asset-1?audio=0&start=5000&offsetProbe=true"
    });

    expect(failedResponse.statusCode).toBe(200);
    expect(failedResponse.headers["x-ktv-start-offset-ms"]).toBeUndefined();
    expect(failedResponse.json()).toEqual({ startOffsetMs: null });
    expect(nullResponse.statusCode).toBe(200);
    expect(nullResponse.headers["x-ktv-start-offset-ms"]).toBeUndefined();
    expect(nullResponse.json()).toEqual({ startOffsetMs: null });
  });

  it("ignores offsetProbe without an audio track and streams the source file", async () => {
    const { mediaRoot, mediaPath } = await createNasMediaRoot();
    const server = Fastify();
    const mediaGateway = new MediaGateway({
      playableMedia: new FakePlayableMediaRepository(createPlayableAsset({ assetId: "ktv-asset-1", filePath: mediaPath })),
      mediaPathResolver: new MediaPathResolver({ mediaRoot }),
      publicBaseUrl: "http://ktv.local"
    });

    await registerMediaRoutes(server, { mediaGateway });

    const response = await server.inject({
      method: "GET",
      url: "/media/nas/ktv-asset-1?offsetProbe=1"
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("video/x-matroska");
    expect(response.body).toBe("0123456789");
  });

  it("derives the default ffprobe binary from ffmpegBin", async () => {
    const { mediaRoot, mediaPath } = await createNasMediaRoot();
    const proberCalls: Array<Parameters<RemuxStartOffsetProber>[0]> = [];

    const registerWith = async (context: { ffmpegBin?: string; ffprobeBin?: string }): Promise<FastifyInstance> => {
      const fastify = Fastify();
      await registerMediaRoutes(fastify, {
        mediaGateway: new MediaGateway({
          playableMedia: new FakePlayableMediaRepository(
            createPlayableAsset({ assetId: "ktv-asset-1", filePath: mediaPath })
          ),
          mediaPathResolver: new MediaPathResolver({ mediaRoot }),
          publicBaseUrl: "http://ktv.local"
        }),
        remuxStartOffsetProber: async (input) => {
          proberCalls.push(input);
          return 0;
        },
        ...context
      });
      return fastify;
    };

    const siblingServer = await registerWith({ ffmpegBin: "C:\\tools\\ffmpeg\\bin\\ffmpeg.exe" });
    await siblingServer.inject({ method: "GET", url: "/media/nas/ktv-asset-1?audio=1&start=1000&offsetProbe=1" });
    const pathServer = await registerWith({});
    await pathServer.inject({ method: "GET", url: "/media/nas/ktv-asset-1?audio=1&start=1000&offsetProbe=1" });

    expect(proberCalls.map((call) => call.ffprobeBin)).toEqual([
      "C:\\tools\\ffmpeg\\bin\\ffprobe.exe",
      "ffprobe"
    ]);
  });

  it("derives the offset from ffprobe packet json", () => {
    const packets = JSON.stringify({
      packets: [
        { pts_time: "60.000000", flags: "K__" },
        { pts_time: "61.000000", flags: "___" },
        { pts_time: "78.000000", flags: "K__" },
        { pts_time: "79.500000", flags: "___" },
        { pts_time: "82.000000", flags: "K__" },
        { pts_time: "82.400000", flags: "___" },
        { pts_time: "83.000000", flags: "K__" }
      ]
    });

    // start 前最近 keyframe 是 82.000s → 提前量 400ms;start 之后的 keyframe 忽略
    expect(startOffsetMsFromProbeOutput(packets, 82400)).toBe(400);
    // 窗口内没有 keyframe → null
    expect(
      startOffsetMsFromProbeOutput(JSON.stringify({ packets: [{ pts_time: "1.000000", flags: "___" }] }), 82400)
    ).toBeNull();
    // 坏 JSON / 非 packets 结构 → null
    expect(startOffsetMsFromProbeOutput("not-json", 82400)).toBeNull();
    expect(startOffsetMsFromProbeOutput("{}", 82400)).toBeNull();
    // pts 缺失(N/A)的包跳过;start=0 时首个 keyframe 即 0 → 偏移 0
    expect(
      startOffsetMsFromProbeOutput(
        JSON.stringify({ packets: [{ pts_time: "N/A", flags: "K__" }, { pts_time: "0.000000", flags: "K__" }] }),
        0
      )
    ).toBe(0);
  });
});

async function createNasMediaRoot(): Promise<{ mediaRoot: string; mediaPath: string }> {
  const mediaRoot = await mkdtemp(join(tmpdir(), "home-ktv-nas-media-"));
  const mediaPath = join(mediaRoot, "sample.mkv");
  await writeFile(mediaPath, Buffer.from("0123456789"));
  return { mediaRoot, mediaPath };
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
