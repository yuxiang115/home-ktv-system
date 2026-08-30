import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Fastify from "fastify";
import { MediaPathResolver } from "../modules/assets/media-path-resolver.js";
import type { TranscribeAudioInput } from "../modules/online-supplement/asr-client.js";
import {
  registerMediaRoutes,
  type KtvIndexRawAssetRepository,
  type KtvIndexRawAssetRow
} from "../routes/media.js";
import { describe, expect, it } from "vitest";

describe("KTV index raw media route", () => {
  it("streams an indexed NAS asset with range support", async () => {
    const mediaRoot = await mkdtemp(join(tmpdir(), "home-ktv-raw-media-"));
    const mediaPath = join(mediaRoot, "sample.mkv");
    await writeFile(mediaPath, Buffer.from("0123456789"));
    const server = Fastify();

    await registerMediaRoutes(server, {
      ktvIndexRawAssets: new FakeRawAssetRepository({
        id: "ktv-asset-1",
        filePath: mediaPath,
        lyricFile: null,
        karaokeLyricFile: null
      }),
      mediaPathResolver: new MediaPathResolver({ mediaRoot })
    });

    const response = await server.inject({
      method: "GET",
      url: "/media/ktv-index/ktv-asset-1/raw",
      headers: {
        range: "bytes=2-5"
      }
    });

    expect(response.statusCode).toBe(206);
    expect(response.headers["content-type"]).toContain("video/x-matroska");
    expect(response.headers["content-range"]).toBe("bytes 2-5/10");
    expect(response.body).toBe("2345");
  });

  it("serves the sidecar lrc file as utf-8 text", async () => {
    const mediaRoot = await mkdtemp(join(tmpdir(), "home-ktv-raw-media-"));
    const mediaPath = join(mediaRoot, "sample.mkv");
    const lyricPath = join(mediaRoot, "sample.lrc");
    await writeFile(mediaPath, Buffer.from("0123456789"));
    await writeFile(lyricPath, "[00:12.00]孤勇者\n", "utf8");
    const server = Fastify();

    await registerMediaRoutes(server, {
      ktvIndexRawAssets: new FakeRawAssetRepository({
        id: "ktv-asset-1",
        filePath: mediaPath,
        lyricFile: lyricPath,
        karaokeLyricFile: null
      }),
      mediaPathResolver: new MediaPathResolver({ mediaRoot })
    });

    const response = await server.inject({
      method: "GET",
      url: "/media/ktv-index/ktv-asset-1/lyrics"
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toContain("[00:12.00]孤勇者");
  });

  it("returns 404 when the asset has no lyric file", async () => {
    const mediaRoot = await mkdtemp(join(tmpdir(), "home-ktv-raw-media-"));
    const server = Fastify();

    await registerMediaRoutes(server, {
      ktvIndexRawAssets: new FakeRawAssetRepository({
        id: "ktv-asset-1",
        filePath: join(mediaRoot, "sample.mkv"),
        lyricFile: null,
        karaokeLyricFile: null
      }),
      mediaPathResolver: new MediaPathResolver({ mediaRoot })
    });

    const response = await server.inject({
      method: "GET",
      url: "/media/ktv-index/ktv-asset-1/lyrics"
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "LYRICS_NOT_FOUND" });
  });

  it("serves the char-level karaoke json when present", async () => {
    const mediaRoot = await mkdtemp(join(tmpdir(), "home-ktv-raw-media-"));
    const karaokePath = join(mediaRoot, "sample.karaoke.json");
    await writeFile(
      karaokePath,
      JSON.stringify({ lines: [{ start: 1, end: 2, text: "词", words: [{ text: "词", start: 1, end: 2 }] }] }),
      "utf8"
    );
    const server = Fastify();

    await registerMediaRoutes(server, {
      ktvIndexRawAssets: new FakeRawAssetRepository({
        id: "ktv-asset-1",
        filePath: join(mediaRoot, "sample.mkv"),
        lyricFile: null,
        karaokeLyricFile: karaokePath
      }),
      mediaPathResolver: new MediaPathResolver({ mediaRoot })
    });

    const response = await server.inject({
      method: "GET",
      url: "/media/ktv-index/ktv-asset-1/karaoke-lyrics"
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    const payload = response.json() as { lines: { text: string }[] };
    expect(payload.lines[0]?.text).toBe("词");
  });

  it("returns 404 for karaoke-lyrics when the asset was never aligned", async () => {
    const mediaRoot = await mkdtemp(join(tmpdir(), "home-ktv-raw-media-"));
    const server = Fastify();

    await registerMediaRoutes(server, {
      ktvIndexRawAssets: new FakeRawAssetRepository({
        id: "ktv-asset-1",
        filePath: join(mediaRoot, "sample.mkv"),
        lyricFile: null,
        karaokeLyricFile: null
      }),
      mediaPathResolver: new MediaPathResolver({ mediaRoot })
    });

    const response = await server.inject({
      method: "GET",
      url: "/media/ktv-index/ktv-asset-1/karaoke-lyrics"
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "KARAOKE_NOT_FOUND" });
  });
});

describe("regenerate-lyrics route", () => {
  const onlineStem = "薛之謙_Joker_Xue-演員-國語-流行";

  async function createOnlineMediaRoot(): Promise<{ mediaRoot: string; mediaPath: string }> {
    const mediaRoot = await mkdtemp(join(tmpdir(), "home-ktv-regen-lyrics-"));
    const mediaPath = join(mediaRoot, "_online", `${onlineStem}.mkv`);
    await mkdir(join(mediaRoot, "_online"), { recursive: true });
    await writeFile(mediaPath, Buffer.from("mkv"));
    return { mediaRoot, mediaPath };
  }

  it("re-queries LRCLIB, writes the sidecar lrc, and updates lyric_file", async () => {
    const { mediaRoot, mediaPath } = await createOnlineMediaRoot();
    const repo = new FakeRawAssetRepository({
      id: "ktv-asset-1",
      filePath: mediaPath,
      lyricFile: null,
      karaokeLyricFile: null
    });
    const server = Fastify();
    await registerMediaRoutes(server, {
      ktvIndexRawAssets: repo,
      mediaPathResolver: new MediaPathResolver({ mediaRoot }),
      lyricsFetchImpl: createLrclibFetchMock({
        syncedLyrics: "[00:12.00]演員\n[00:15.00]該配合你演出的我演視而不見"
      })
    });

    const response = await server.inject({
      method: "POST",
      url: "/media/ktv-index/ktv-asset-1/regenerate-lyrics"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "found",
      lyricFile: join(mediaRoot, "_online", `${onlineStem}.lrc`)
    });
    const written = await readFile(join(mediaRoot, "_online", `${onlineStem}.lrc`), "utf8");
    expect(written).toContain("[00:12.00]演員");
    expect(repo.updatedLyricFiles).toEqual([
      { indexedAssetId: "ktv-asset-1", lyricFile: join(mediaRoot, "_online", `${onlineStem}.lrc`) }
    ]);
  });

  it("treats an LRCLIB miss as 200 not_found without touching the row", async () => {
    const { mediaRoot, mediaPath } = await createOnlineMediaRoot();
    const repo = new FakeRawAssetRepository({
      id: "ktv-asset-1",
      filePath: mediaPath,
      lyricFile: null,
      karaokeLyricFile: null
    });
    const server = Fastify();
    await registerMediaRoutes(server, {
      ktvIndexRawAssets: repo,
      mediaPathResolver: new MediaPathResolver({ mediaRoot }),
      lyricsFetchImpl: createLrclibFetchMock(null)
    });

    const response = await server.inject({
      method: "POST",
      url: "/media/ktv-index/ktv-asset-1/regenerate-lyrics"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "not_found" });
    expect(await stat(join(mediaRoot, "_online", `${onlineStem}.lrc`)).catch(() => null)).toBeNull();
    expect(repo.updatedLyricFiles).toEqual([]);
  });

  it("falls back to ASR transcription when LRCLIB misses and stores the generated lrc", async () => {
    const { mediaRoot, mediaPath } = await createOnlineMediaRoot();
    const repo = new FakeRawAssetRepository({
      id: "ktv-asset-1",
      filePath: mediaPath,
      lyricFile: null,
      karaokeLyricFile: null
    });
    const transcriberCalls: TranscribeAudioInput[] = [];
    const server = Fastify();
    await registerMediaRoutes(server, {
      ktvIndexRawAssets: repo,
      mediaPathResolver: new MediaPathResolver({ mediaRoot }),
      lyricsFetchImpl: createLrclibFetchMock(null),
      asrBaseUrl: "http://mac-asr.local:8000",
      asrModel: "mlx-community/Qwen3-ASR-1.7B-4bit",
      // 跳过真实 ffmpeg:抽音频步骤直接产出占位文件,fake transcriber 接收任意路径。
      asrAudioExtractor: async ({ outputPath }) => {
        await writeFile(outputPath, Buffer.from("fake 16k mono m4a"));
      },
      asrTranscriber: async (input) => {
        transcriberCalls.push(input);
        return {
          text: "演員 該配合你演出的我演視而不見",
          segments: [
            { start: 12.3, end: 15.2, text: "演員" },
            { start: 15.5, end: 20.1, text: "   " },
            { start: 20.5, end: 24, text: "..." },
            { start: 25.14, end: 30, text: "該配合你演出的我演視而不見" }
          ]
        };
      }
    });

    const response = await server.inject({
      method: "POST",
      url: "/media/ktv-index/ktv-asset-1/regenerate-lyrics"
    });

    const lyricFile = join(mediaRoot, "_online", `${onlineStem}.lrc`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "transcribed", lyricFile });
    const written = await readFile(lyricFile, "utf8");
    expect(written).toContain("[00:12.30]演員");
    expect(written).toContain("[00:25.14]該配合你演出的我演視而不見");
    // 纯空白段/纯符号段不落 LRC(与 align_lyrics.py 的 isalnum 过滤一致)
    expect(written.split("\n").filter((line) => line.trim())).toHaveLength(2);
    expect(repo.updatedLyricFiles).toEqual([{ indexedAssetId: "ktv-asset-1", lyricFile }]);
    // 转写请求带上服务地址/模型与歌手歌名上下文 prompt
    expect(transcriberCalls).toEqual([
      expect.objectContaining({
        baseUrl: "http://mac-asr.local:8000",
        model: "mlx-community/Qwen3-ASR-1.7B-4bit",
        prompt: "这是薛之謙 Joker Xue演唱的歌曲《演員》，请转写歌词文本"
      })
    ]);
    expect(transcriberCalls[0]?.filePath ?? "").toMatch(/audio\.m4a$/u);
  });

  it("reports transcribed_no_timing without writing the lrc when segments are missing", async () => {
    const { mediaRoot, mediaPath } = await createOnlineMediaRoot();
    const repo = new FakeRawAssetRepository({
      id: "ktv-asset-1",
      filePath: mediaPath,
      lyricFile: null,
      karaokeLyricFile: null
    });
    const server = Fastify();
    await registerMediaRoutes(server, {
      ktvIndexRawAssets: repo,
      mediaPathResolver: new MediaPathResolver({ mediaRoot }),
      lyricsFetchImpl: createLrclibFetchMock(null),
      asrBaseUrl: "http://mac-asr.local:8000",
      asrAudioExtractor: async ({ outputPath }) => {
        await writeFile(outputPath, Buffer.from("fake 16k mono m4a"));
      },
      asrTranscriber: async () => ({ text: "該配合你演出的我演視而不見", segments: [] })
    });

    const response = await server.inject({
      method: "POST",
      url: "/media/ktv-index/ktv-asset-1/regenerate-lyrics"
    });

    // 无时间轴的纯文本不落库(无法做行级同步),仅提示
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "transcribed_no_timing" });
    expect(await stat(join(mediaRoot, "_online", `${onlineStem}.lrc`)).catch(() => null)).toBeNull();
    expect(repo.updatedLyricFiles).toEqual([]);
  });

  it("returns 502 ASR_UNAVAILABLE when the transcriber fails", async () => {
    const { mediaRoot, mediaPath } = await createOnlineMediaRoot();
    const repo = new FakeRawAssetRepository({
      id: "ktv-asset-1",
      filePath: mediaPath,
      lyricFile: null,
      karaokeLyricFile: null
    });
    const server = Fastify();
    await registerMediaRoutes(server, {
      ktvIndexRawAssets: repo,
      mediaPathResolver: new MediaPathResolver({ mediaRoot }),
      lyricsFetchImpl: createLrclibFetchMock(null),
      asrBaseUrl: "http://mac-asr.local:8000",
      asrAudioExtractor: async ({ outputPath }) => {
        await writeFile(outputPath, Buffer.from("fake 16k mono m4a"));
      },
      asrTranscriber: async () => {
        throw new Error("asr service down");
      }
    });

    const response = await server.inject({
      method: "POST",
      url: "/media/ktv-index/ktv-asset-1/regenerate-lyrics"
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "ASR_UNAVAILABLE" });
    expect(await stat(join(mediaRoot, "_online", `${onlineStem}.lrc`)).catch(() => null)).toBeNull();
    expect(repo.updatedLyricFiles).toEqual([]);
  });

  it("returns 422 when the file name cannot be parsed into artist and track", async () => {
    const mediaRoot = await mkdtemp(join(tmpdir(), "home-ktv-regen-lyrics-"));
    const repo = new FakeRawAssetRepository({
      id: "ktv-asset-1",
      filePath: join(mediaRoot, "_online", "没有分隔段的文件名.mkv"),
      lyricFile: null,
      karaokeLyricFile: null
    });
    const server = Fastify();
    await registerMediaRoutes(server, {
      ktvIndexRawAssets: repo,
      mediaPathResolver: new MediaPathResolver({ mediaRoot }),
      lyricsFetchImpl: createLrclibFetchMock({ syncedLyrics: "[00:12.00]不應該命中" })
    });

    const response = await server.inject({
      method: "POST",
      url: "/media/ktv-index/ktv-asset-1/regenerate-lyrics"
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: "UNPARSABLE_FILENAME" });
    expect(repo.updatedLyricFiles).toEqual([]);
  });

  it("returns 502 when every LRCLIB variant fails at the network level", async () => {
    const mediaRoot = await mkdtemp(join(tmpdir(), "home-ktv-regen-lyrics-"));
    const repo = new FakeRawAssetRepository({
      id: "ktv-asset-1",
      filePath: join(mediaRoot, "_online", `${onlineStem}.mkv`),
      lyricFile: null,
      karaokeLyricFile: null
    });
    const server = Fastify();
    await registerMediaRoutes(server, {
      ktvIndexRawAssets: repo,
      mediaPathResolver: new MediaPathResolver({ mediaRoot }),
      lyricsFetchImpl: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch
    });

    const response = await server.inject({
      method: "POST",
      url: "/media/ktv-index/ktv-asset-1/regenerate-lyrics"
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "LYRICS_PROVIDER_UNAVAILABLE" });
    expect(repo.updatedLyricFiles).toEqual([]);
  });
});

// LRCLIB mock:/api/get 与 /api/search 都按同一条记录应答;record 为 null 时
// /api/get 404、/api/search 返回空数组(所有变体未命中)。
function createLrclibFetchMock(record: { syncedLyrics: string } | null): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/api/get")) {
      if (!record) {
        return new Response("not found", { status: 404 });
      }
      return Response.json(record);
    }
    if (url.pathname.endsWith("/api/search")) {
      return Response.json(record ? [record] : []);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

class FakeRawAssetRepository implements KtvIndexRawAssetRepository {
  readonly updatedLyricFiles: Array<{ indexedAssetId: string; lyricFile: string }> = [];

  constructor(private readonly row: KtvIndexRawAssetRow | null) {}

  async findRawAssetById(): Promise<KtvIndexRawAssetRow | null> {
    return this.row;
  }

  async updateLyricFile(indexedAssetId: string, lyricFile: string): Promise<void> {
    this.updatedLyricFiles.push({ indexedAssetId, lyricFile });
  }
}
