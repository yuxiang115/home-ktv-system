import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OnlineSupplementTask, SupplementTaskStage } from "@home-ktv/domain";
import {
  SupplementOrchestrator,
  type StageExecuteInput,
  type StageExecuteResult,
  type StageHandler
} from "../modules/online-supplement/supplement-orchestrator.js";
import {
  PgOnlineSupplementTaskRepository,
  type OnlineSupplementTaskRepository
} from "../modules/online-supplement/supplement-task-repository.js";
import { IndexStageHandler } from "../modules/online-supplement/handlers/index-handler.js";
import { DownloadStageHandler } from "../modules/online-supplement/handlers/download-handler.js";
import type { OnlineProvider } from "../modules/online-supplement/online-provider.js";
import type { QueryExecutor } from "../db/query-executor.js";
import {
  LyricsStageHandler,
  supplementSearchNames
} from "../modules/online-supplement/handlers/lyrics-handler.js";
import { fallbackSpecName } from "../modules/online-supplement/handlers/rename-llm-handler.js";
import {
  AlignStageHandler,
  alignerLanguageForSpecName,
  karaokeJsonPath
} from "../modules/online-supplement/handlers/align-handler.js";
import { VocalRemoveStageHandler } from "../modules/online-supplement/handlers/vocal-remove-handler.js";
import { MixStageHandler } from "../modules/online-supplement/handlers/mix-handler.js";
import {
  pickDownloadArtifact,
  YtDlpProvider
} from "../modules/online-supplement/providers/yt-dlp-provider.js";
import type { OnlineDownloadInput } from "../modules/online-supplement/online-provider.js";

const tempDirs: string[] = [];

async function createWorkDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "home-ktv-supplement-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createTask(overrides: Partial<OnlineSupplementTask> = {}): OnlineSupplementTask {
  return {
    id: "task-1",
    roomId: "room-1",
    provider: "youtube-yt-dlp",
    providerCandidateId: "vid-1",
    sourceUrl: "https://www.youtube.com/watch?v=vid-1",
    title: "Some Official MV",
    artistName: "Some Artist",
    durationMs: 240000,
    providerPayload: {},
    workflowId: "youtube-enhanced",
    status: "processing",
    stage: "lyrics",
    stageStatus: "running",
    stageProgressPercent: 0,
    stageMessage: "",
    failureReason: null,
    failureStage: null,
    llmRenamedTitle: null,
    finalFilePath: null,
    lyricFile: null,
    readySongId: null,
    workerId: "worker-1",
    workerLeaseUntil: null,
    requestedBy: null,
    downloadAt: null,
    readyAt: null,
    failedAt: null,
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
    ...overrides
  };
}

interface InputHarness {
  input: StageExecuteInput;
  leaseCalls: Date[];
  progressCalls: Array<{ percent: number; message: string }>;
  logs: string[];
}

function createInput(task: OnlineSupplementTask, workDir: string): InputHarness {
  const leaseCalls: Date[] = [];
  const progressCalls: Array<{ percent: number; message: string }> = [];
  const logs: string[] = [];
  const input: StageExecuteInput = {
    task,
    workerId: "worker-1",
    workDir,
    renewLease: async (leaseUntil) => {
      leaseCalls.push(leaseUntil);
    },
    reportProgress: async (percent, message) => {
      progressCalls.push({ percent, message });
    },
    log: (message) => {
      logs.push(message);
    }
  };
  return { input, leaseCalls, progressCalls, logs };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

describe("supplementSearchNames", () => {
  it("parses artist and track from the LLM spec name", () => {
    const names = supplementSearchNames(
      createTask({ llmRenamedTitle: "邓紫棋_林俊杰-手心的蔷薇_Live-国语-流行" })
    );

    expect(names).toEqual({
      artistName: "邓紫棋 林俊杰",
      trackName: "手心的蔷薇 Live"
    });
  });

  it("falls back to the raw task artist and title", () => {
    const names = supplementSearchNames(createTask());

    expect(names).toEqual({ artistName: "Some Artist", trackName: "Some Official MV" });
  });
});

describe("fallbackSpecName", () => {
  it("extracts artist and title from the bracket pattern common on official MV uploads", () => {
    expect(fallbackSpecName("薛之謙 Joker Xue【演員】Official Music Video", "薛之謙 JokerXue"))
      .toBe("薛之謙_Joker_Xue-演員-其他-流行");
  });

  it("extracts artist and title from dash-separated titles", () => {
    expect(fallbackSpecName("林俊傑 JJ Lin - 江南 River South (Official MV)", "太合音樂"))
      .toBe("林俊傑_JJ_Lin-江南_River_South-其他-流行");
  });

  it("keeps the spec-name pattern even for noisy titles with no structure", () => {
    const name = fallbackSpecName("官方完整版 MV 4K", "Some Uploader");
    expect(name).toBe("Some_Uploader-官方完整版_MV_4K-其他-流行");
  });
});

describe("AlignStageHandler", () => {
  const handlerOptions = {
    bin: "python.exe",
    scriptPath: "python/align_lyrics.py",
    model: "Qwen/Qwen3-ForcedAligner-0.6B",
    device: "cuda:0",
    dtype: "bfloat16",
    demucsModel: "htdemucs"
  };

  async function prepareVocalsAndLyrics(workDir: string): Promise<void> {
    const vocalsDir = path.join(workDir, "_stems", "task-1", "htdemucs", "task-1");
    await mkdir(vocalsDir, { recursive: true });
    await writeFile(path.join(vocalsDir, "vocals.wav"), "pcm");
    await mkdir(path.join(workDir, "_lyrics"), { recursive: true });
    await writeFile(path.join(workDir, "_lyrics", "task-1.lrc"), "[00:10.00]测试\n", "utf8");
  }

  it("skips when no aligner bin is configured", async () => {
    const workDir = await createWorkDir();
    await prepareVocalsAndLyrics(workDir);
    const handler = new AlignStageHandler({ ...handlerOptions, bin: "", run: async () => {
      throw new Error("should not run");
    } });
    const { input } = createInput(createTask({ stage: "align" }), workDir);

    const result = await handler.execute(input);

    expect(result.status).toBe("completed");
    expect(result.message).toContain("no aligner configured");
  });

  it("runs the aligner with language mapped from the spec name and verifies output", async () => {
    const workDir = await createWorkDir();
    await prepareVocalsAndLyrics(workDir);
    const calls: Array<{ bin: string; args: string[] }> = [];
    const handler = new AlignStageHandler({
      ...handlerOptions,
      run: async (bin, args) => {
        calls.push({ bin, args: [...args] });
        const outIndex = args.indexOf("--out");
        const out = outIndex >= 0 ? (args[outIndex + 1] ?? "") : "";
        await mkdir(path.dirname(out), { recursive: true });
        await writeFile(out, JSON.stringify({
          lines: [{ start: 10, end: 12, text: "测试", words: [{ text: "测", start: 10, end: 11 }] }]
        }), "utf8");
      }
    });
    const { input, leaseCalls } = createInput(
      createTask({ stage: "align", llmRenamedTitle: "薛之謙-演員-國語-流行" }),
      workDir
    );

    const result = await handler.execute(input);

    expect(result.status).toBe("completed");
    expect(result.message).toBe("aligned");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toContain("--language");
    expect(calls[0]?.args).toContain("Chinese");
    expect(calls[0]?.args).toContain("python/align_lyrics.py");
    expect(leaseCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("completes (best-effort) when the aligner fails", async () => {
    const workDir = await createWorkDir();
    await prepareVocalsAndLyrics(workDir);
    const handler = new AlignStageHandler({
      ...handlerOptions,
      run: async () => {
        throw new Error("model download failed");
      }
    });
    const { input } = createInput(createTask({ stage: "align" }), workDir);

    const result = await handler.execute(input);

    expect(result.status).toBe("completed");
    expect(result.message).toContain("align failed");
    expect(result.message).toContain("model download failed");
  });

  it("skips when the vocals stem is missing", async () => {
    const workDir = await createWorkDir();
    const handler = new AlignStageHandler({
      ...handlerOptions,
      run: async () => {
        throw new Error("should not run");
      }
    });
    const { input } = createInput(createTask({ stage: "align" }), workDir);

    const result = await handler.execute(input);

    expect(result.status).toBe("completed");
    expect(result.message).toContain("no vocals stem");
  });

  it("deletes a stale karaoke json from a previous attempt when the aligner is disabled", async () => {
    const workDir = await createWorkDir();
    await prepareVocalsAndLyrics(workDir);
    const stale = karaokeJsonPath(workDir, "task-1");
    await mkdir(path.dirname(stale), { recursive: true });
    await writeFile(stale, '{"lines":[{"start":1', "utf8");
    const handler = new AlignStageHandler({ ...handlerOptions, bin: "", run: async () => {
      throw new Error("should not run");
    } });
    const { input } = createInput(createTask({ stage: "align" }), workDir);

    const result = await handler.execute(input);

    expect(result.status).toBe("completed");
    await expect(stat(stale)).rejects.toThrow();
  });

  it("deletes a truncated karaoke output and falls back to lrc", async () => {
    const workDir = await createWorkDir();
    await prepareVocalsAndLyrics(workDir);
    const handler = new AlignStageHandler({
      ...handlerOptions,
      run: async (_bin, args) => {
        const outIndex = args.indexOf("--out");
        const out = outIndex >= 0 ? (args[outIndex + 1] ?? "") : "";
        // 模拟超时被 kill 时 python 写了一半的文件
        await writeFile(out, '{"lines":[{"start":10.2,"end":12.5,"text":"测', "utf8");
      }
    });
    const { input } = createInput(createTask({ stage: "align" }), workDir);
    const out = karaokeJsonPath(workDir, "task-1");

    const result = await handler.execute(input);

    expect(result.status).toBe("completed");
    expect(result.message).toContain("align output invalid");
    await expect(stat(out)).rejects.toThrow();
  });
});

describe("alignerLanguageForSpecName", () => {
  it("maps spec-name language markers to aligner languages", () => {
    expect(alignerLanguageForSpecName("薛之謙-演員-國語-流行")).toBe("Chinese");
    expect(alignerLanguageForSpecName("陳奕迅-孤勇者-粤语-流行")).toBe("Cantonese");
    expect(alignerLanguageForSpecName("Adele-Hello-英语-流行")).toBe("English");
    expect(alignerLanguageForSpecName("X-Y-日语-流行")).toBe("Japanese");
    expect(alignerLanguageForSpecName(null)).toBe("Chinese");
    expect(alignerLanguageForSpecName("X-Y-火星语-流行")).toBe("Chinese");
  });

  it("maps traditional markers (the naming convention this repo actually uses)", () => {
    expect(alignerLanguageForSpecName("陳奕迅-孤勇者-粵語-流行")).toBe("Cantonese");
    expect(alignerLanguageForSpecName("Adele-Hello-英語-流行")).toBe("English");
    expect(alignerLanguageForSpecName("X-Y-日語-流行")).toBe("Japanese");
    expect(alignerLanguageForSpecName("X-Y-韓語-流行")).toBe("Korean");
    expect(alignerLanguageForSpecName("X-Y-國語_華語-流行")).toBe("Chinese");
  });
});

describe("LyricsStageHandler", () => {
  it("writes a synced lrc file from the lrclib exact match", async () => {
    const workDir = await createWorkDir();
    const requestedUrls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      requestedUrls.push(url.toString());
      return jsonResponse({ syncedLyrics: "[00:12.34]孤勇者\n", plainLyrics: "孤勇者" });
    };
    const handler = new LyricsStageHandler({ baseUrl: "https://lrclib.net/", fetchImpl });
    const { input } = createInput(
      createTask({ llmRenamedTitle: "陈奕迅-孤勇者-国语-流行", durationMs: 240000 }),
      workDir
    );

    const result = await handler.execute(input);

    expect(result.status).toBe("completed");
    expect(result.lyricFile).toBe(path.join(workDir, "_lyrics", "task-1.lrc"));

    const firstUrl = new URL(requestedUrls[0] ?? "");
    expect(firstUrl.pathname).toBe("/api/get");
    expect(firstUrl.searchParams.get("artist_name")).toBe("陈奕迅");
    expect(firstUrl.searchParams.get("track_name")).toBe("孤勇者");
    expect(firstUrl.searchParams.get("duration")).toBe("240");
    expect(requestedUrls).toHaveLength(1);

    const { readFile } = await import("node:fs/promises");
    const content = await readFile(result.lyricFile ?? "", "utf8");
    expect(content).toContain("[00:12.34]孤勇者");
  });

  it("falls back to search results when the exact match misses", async () => {
    const workDir = await createWorkDir();
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/get") {
        return jsonResponse({ message: "Not Found" }, 404);
      }
      return jsonResponse([
        { syncedLyrics: null, instrumental: false },
        { syncedLyrics: "[00:01.00]hello", instrumental: false },
        { syncedLyrics: "[00:02.00]skip instrumental", instrumental: true }
      ]);
    };
    const handler = new LyricsStageHandler({ baseUrl: "https://lrclib.net", fetchImpl });
    const { input } = createInput(createTask({ durationMs: null }), workDir);

    const result = await handler.execute(input);

    expect(result.status).toBe("completed");
    expect(result.lyricFile).toBe(path.join(workDir, "_lyrics", "task-1.lrc"));
  });

  it("completes without a lyric file when lrclib has nothing", async () => {
    const workDir = await createWorkDir();
    const fetchImpl: typeof fetch = async () => jsonResponse([], 200);
    const handler = new LyricsStageHandler({
      baseUrl: "https://lrclib.net",
      fetchImpl,
      timeoutMs: 500
    });
    const { input } = createInput(createTask({ durationMs: null }), workDir);

    const result = await handler.execute(input);

    expect(result.status).toBe("completed");
    expect(result.lyricFile).toBeUndefined();
    expect(result.message).toContain("not found");
  });

  it("matches via the simplified-chinese variant when the original name misses", async () => {
    const workDir = await createWorkDir();
    const requestedArtists: string[] = [];
    const fetchImpl: typeof fetch = async (request) => {
      const url = new URL(String(request));
      if (url.pathname === "/api/get") {
        const artist = url.searchParams.get("artist_name") ?? "";
        requestedArtists.push(artist);
        // 只有简体歌手名命中
        if (artist === "林俊杰") {
          return jsonResponse({ syncedLyrics: "[00:10.00]江南\n" });
        }
        return jsonResponse({ message: "Not Found" }, 404);
      }
      return jsonResponse([]);
    };
    const handler = new LyricsStageHandler({ baseUrl: "https://lrclib.net", fetchImpl });
    const { input } = createInput(
      createTask({
        durationMs: null,
        llmRenamedTitle: "林俊傑_JJ_Lin-江南_River_South-國語-流行"
      }),
      workDir
    );

    const result = await handler.execute(input);

    expect(result.status).toBe("completed");
    expect(result.lyricFile).toBe(path.join(workDir, "_lyrics", "task-1.lrc"));
    // 原文(繁体+英文)未命中后,第二个变体(简体)成功
    expect(requestedArtists).toContain("林俊杰");
  });

  it("completes without failing when lrclib is unreachable", async () => {
    const workDir = await createWorkDir();
    const fetchImpl: typeof fetch = async () => {
      throw new Error("network down");
    };
    const handler = new LyricsStageHandler({ baseUrl: "https://lrclib.net", fetchImpl });
    const { input } = createInput(createTask({ durationMs: null }), workDir);

    const result = await handler.execute(input);

    expect(result.status).toBe("completed");
    expect(result.lyricFile).toBeUndefined();
    expect(result.message).toContain("lrclib error");
  });
});

describe("VocalRemoveStageHandler", () => {
  it("runs demucs with the configured model and device, then verifies the accompaniment", async () => {
    const workDir = await createWorkDir();
    await mkdir(path.join(workDir, "_downloads"), { recursive: true });
    await writeFile(path.join(workDir, "_downloads", "task-1.mkv"), "video");

    const calls: Array<{ bin: string; args: string[]; timeoutMs: number }> = [];
    const handler = new VocalRemoveStageHandler({
      bin: "demucs",
      device: "cuda",
      model: "mdx_extra_q",
      workDir,
      timeoutMs: 60000,
      run: async (bin, args, timeoutMs) => {
        calls.push({ bin, args: [...args], timeoutMs });
        const outDir = args[args.indexOf("-o") + 1] ?? "";
        const model = args[args.indexOf("-n") + 1] ?? "";
        const src = args.at(-1) ?? "";
        const stem = path.basename(src, path.extname(src));
        await mkdir(path.join(outDir, model, stem), { recursive: true });
        await writeFile(path.join(outDir, model, stem, "no_vocals.wav"), "pcm");
      }
    });
    const { input, leaseCalls } = createInput(createTask({ stage: "vocal_remove" }), workDir);

    const result = await handler.execute(input);

    expect(result.status).toBe("completed");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.bin).toBe("demucs");
    expect(calls[0]?.args).toContain("--two-stems");
    expect(calls[0]?.args).toContain("vocals");
    expect(calls[0]?.args).toContain("-n");
    expect(calls[0]?.args).toContain("mdx_extra_q");
    expect(calls[0]?.args).toContain("-d");
    expect(calls[0]?.args).toContain("cuda");
    expect(leaseCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("fails when the downloaded source is missing", async () => {
    const workDir = await createWorkDir();
    const handler = new VocalRemoveStageHandler({
      bin: "demucs",
      device: "cpu",
      workDir,
      run: async () => {
        throw new Error("should not run");
      }
    });
    const { input } = createInput(createTask({ stage: "vocal_remove" }), workDir);

    const result = await handler.execute(input);

    expect(result.status).toBe("failed");
    expect(result.failureReason).toContain("source audio not found");
  });

  it("fails with a reason after retrying demucs twice", async () => {
    const workDir = await createWorkDir();
    await mkdir(path.join(workDir, "_downloads"), { recursive: true });
    await writeFile(path.join(workDir, "_downloads", "task-1.mkv"), "video");

    let attempts = 0;
    const handler = new VocalRemoveStageHandler({
      bin: "demucs",
      device: "cpu",
      workDir,
      timeoutMs: 1000,
      run: async () => {
        attempts += 1;
        throw new Error("boom");
      }
    });
    const { input } = createInput(createTask({ stage: "vocal_remove" }), workDir);

    const result = await handler.execute(input);

    expect(result.status).toBe("failed");
    expect(attempts).toBe(2);
    expect(result.failureReason).toContain("demucs failed: boom");
  }, 15000);

  it("fails when demucs produces no accompaniment", async () => {
    const workDir = await createWorkDir();
    await mkdir(path.join(workDir, "_downloads"), { recursive: true });
    await writeFile(path.join(workDir, "_downloads", "task-1.mkv"), "video");

    const handler = new VocalRemoveStageHandler({
      bin: "demucs",
      device: "cpu",
      workDir,
      run: async () => undefined
    });
    const { input } = createInput(createTask({ stage: "vocal_remove" }), workDir);

    const result = await handler.execute(input);

    expect(result.status).toBe("failed");
    expect(result.failureReason).toContain("produced no accompaniment");
  });
});

describe("MixStageHandler", () => {
  it("mixes a dual-track mkv with labeled vocal track roles", async () => {
    const workDir = await createWorkDir();
    await mkdir(path.join(workDir, "_downloads"), { recursive: true });
    await writeFile(path.join(workDir, "_downloads", "task-1.mkv"), "video");
    await mkdir(path.join(workDir, "_stems", "task-1", "mdx_extra_q", "task-1"), { recursive: true });
    await writeFile(
      path.join(workDir, "_stems", "task-1", "mdx_extra_q", "task-1", "no_vocals.wav"),
      "pcm"
    );

    const calls: Array<{ bin: string; args: string[] }> = [];
    const handler = new MixStageHandler({
      ffmpegBin: "ffmpeg",
      model: "mdx_extra_q",
      workDir,
      run: async (bin, args) => {
        calls.push({ bin, args: [...args] });
        await mkdir(path.join(workDir, "_mixed"), { recursive: true });
        await writeFile(path.join(workDir, "_mixed", "task-1.mkv"), "mkv");
      }
    });
    const { input } = createInput(createTask({ stage: "mix" }), workDir);

    const result = await handler.execute(input);

    expect(result.status).toBe("completed");
    expect(result.finalFilePath).toBe(path.join(workDir, "_mixed", "task-1.mkv"));
    expect(calls[0]?.bin).toBe("ffmpeg");
    expect(calls[0]?.args).toContain(path.join(workDir, "_stems", "task-1", "mdx_extra_q", "task-1", "no_vocals.wav"));
    expect(calls[0]?.args).toContain("title=原唱");
    expect(calls[0]?.args).toContain("title=伴奏");
    expect(calls[0]?.args).toContain("-map");
    expect(calls[0]?.args).toContain("1:a:0");
  });

  it("fails when the accompaniment stem is missing", async () => {
    const workDir = await createWorkDir();
    await mkdir(path.join(workDir, "_downloads"), { recursive: true });
    await writeFile(path.join(workDir, "_downloads", "task-1.mkv"), "video");

    const handler = new MixStageHandler({
      model: "htdemucs",
      workDir,
      run: async () => undefined
    });
    const { input } = createInput(createTask({ stage: "mix" }), workDir);

    const result = await handler.execute(input);

    expect(result.status).toBe("failed");
    expect(result.failureReason).toContain("accompaniment not found");
  });
});

describe("SupplementOrchestrator failure paths", () => {
  function stubHandler(
    stage: SupplementTaskStage,
    execute: (input: StageExecuteInput) => Promise<StageExecuteResult>
  ): StageHandler {
    return { stage, execute };
  }

  function createRepoMock(options: { claimTask?: OnlineSupplementTask; completeStageError?: Error } = {}) {
    const markFailedCalls: Array<{ failureStage: string; reason: string }> = [];
    const repo: OnlineSupplementTaskRepository = {
      createTask: async () => {
        throw new Error("not implemented");
      },
      claimForStage: async () => options.claimTask ?? null,
      claimBatchForStage: async () => (options.claimTask ? [options.claimTask] : []),
      renewLease: async () => undefined,
      updateStageProgress: async () => true,
      completeStage: async () => {
        if (options.completeStageError) {
          throw options.completeStageError;
        }
        return true;
      },
      markReady: async () => true,
      markFailed: async (input) => {
        markFailedCalls.push({ failureStage: input.failureStage, reason: input.reason });
        return true;
      },
      reclaimStaleLeases: async () => 0,
      listRecentByRoom: async () => [],
      findById: async () => null
    };
    return { repo, markFailedCalls };
  }

  it("M2: completeStage 抛错时用 markFailed 补救且不把异常抛出到 worker 循环", async () => {
    const workDir = await createWorkDir();
    const { repo, markFailedCalls } = createRepoMock({
      claimTask: createTask({ stage: "lyrics" }),
      completeStageError: new Error("db flash cut")
    });
    const orchestrator = new SupplementOrchestrator({
      repo,
      handlers: new Map<SupplementTaskStage, StageHandler>([
        ["lyrics", stubHandler("lyrics", async () => ({ status: "completed", message: "lyrics ok" }))]
      ]),
      workDir,
      workerId: "worker-1",
      leaseDurationMs: 60000
    });

    // 以前 completeStage 的异常会一路抛到 worker 循环,任务永远停在 running 被 lease 反复回收
    await expect(orchestrator.processSerialStage("lyrics")).resolves.toBeDefined();

    expect(markFailedCalls).toHaveLength(1);
    expect(markFailedCalls[0]?.failureStage).toBe("lyrics");
    expect(markFailedCalls[0]?.reason).toContain("persistence failed");
    expect(markFailedCalls[0]?.reason).toContain("db flash cut");
  });

  it("M2: markReady 抛错时同样不外抛并走 markFailed 补救", async () => {
    const workDir = await createWorkDir();
    const { repo, markFailedCalls } = createRepoMock({ claimTask: createTask({ stage: "index" }) });
    repo.markReady = async () => {
      throw new Error("stage CHECK constraint violated");
    };
    const orchestrator = new SupplementOrchestrator({
      repo,
      handlers: new Map<SupplementTaskStage, StageHandler>([
        ["index", stubHandler("index", async () => ({ status: "completed", readySongId: "song-1" }))]
      ]),
      workDir,
      workerId: "worker-1",
      leaseDurationMs: 60000
    });

    await expect(orchestrator.processSerialStage("index")).resolves.toBeDefined();

    expect(markFailedCalls).toHaveLength(1);
    expect(markFailedCalls[0]?.failureStage).toBe("index");
    expect(markFailedCalls[0]?.reason).toContain("stage CHECK constraint violated");
  });

  it("M1: handler 抛错进入 markFailed 路径时删除全部中间产物", async () => {
    const workDir = await createWorkDir();
    const intermediates = [
      path.join(workDir, "_downloads", "task-1.mkv"),
      path.join(workDir, "_stems", "task-1", "htdemucs", "task-1", "no_vocals.wav"),
      path.join(workDir, "_mixed", "task-1.mkv"),
      path.join(workDir, "_lyrics", "task-1.lrc"),
      path.join(workDir, "_lyrics", "task-1.karaoke.json")
    ];
    for (const file of intermediates) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "stale", "utf8");
    }

    const { repo, markFailedCalls } = createRepoMock({ claimTask: createTask({ stage: "mix" }) });
    const orchestrator = new SupplementOrchestrator({
      repo,
      handlers: new Map<SupplementTaskStage, StageHandler>([
        ["mix", stubHandler("mix", async () => {
          throw new Error("ffmpeg exploded");
        })]
      ]),
      workDir,
      workerId: "worker-1",
      leaseDurationMs: 60000
    });

    await orchestrator.processSerialStage("mix");

    expect(markFailedCalls).toHaveLength(1);
    expect(markFailedCalls[0]?.reason).toContain("ffmpeg exploded");
    await expect(stat(path.join(workDir, "_downloads", "task-1.mkv"))).rejects.toThrow();
    await expect(stat(path.join(workDir, "_stems", "task-1"))).rejects.toThrow();
    await expect(stat(path.join(workDir, "_mixed", "task-1.mkv"))).rejects.toThrow();
    await expect(stat(path.join(workDir, "_lyrics", "task-1.lrc"))).rejects.toThrow();
    await expect(stat(path.join(workDir, "_lyrics", "task-1.karaoke.json"))).rejects.toThrow();
  });
});

describe("IndexStageHandler", () => {
  function createIndexDbMock(options: { probeTargets: Array<{ id: string; file_path: string }> } = { probeTargets: [] }): QueryExecutor {
    return {
      query: async <TRow>(text: string): Promise<{ rows: TRow[] }> => {
        if (text.includes("INSERT INTO ktv_songs")) {
          return { rows: [{ id: options.probeTargets[0]?.id ?? "song-1" } as TRow] };
        }
        if (text.includes("SELECT id, file_path, technical_status")) {
          return { rows: options.probeTargets as TRow[] };
        }
        if (text.includes("SELECT id FROM ktv_songs")) {
          return { rows: [{ id: options.probeTargets[0]?.id ?? "song-1" } as TRow] };
        }
        return { rows: [] as TRow[] };
      }
    };
  }

  async function prepareDownload(workDir: string): Promise<void> {
    await mkdir(path.join(workDir, "_downloads"), { recursive: true });
    await writeFile(path.join(workDir, "_downloads", "task-1.mkv"), "video");
  }

  it("M4: probe 内部失败计数大于 0 时 message 写明 probe failed,任务仍 completed", async () => {
    const workDir = await createWorkDir();
    await prepareDownload(workDir);
    // probe target 指向不存在的文件 → accessFile 失败 → probe 内部消化为 failed 计数
    const db = createIndexDbMock({
      probeTargets: [{ id: "song-1", file_path: path.join(workDir, "_online", "missing.mkv") }]
    });
    const handler = new IndexStageHandler({ db, workDir });
    const { input, logs } = createInput(createTask({ stage: "index" }), workDir);

    const result = await handler.execute(input);

    expect(result.status).toBe("completed");
    expect(result.readySongId).toBe("song-1");
    expect(result.message).toContain("probe failed 1/1");
    expect(result.message).toContain("无法点播");
    expect(logs).toContain("probe reported failures");
  });

  it("probe 全部成功时 message 仍是 indexed 并清理中间产物", async () => {
    const workDir = await createWorkDir();
    await prepareDownload(workDir);
    // 无待 probe target(如重试任务已 probed)→ failed=0,正常走清理
    const db = createIndexDbMock({ probeTargets: [] });
    const handler = new IndexStageHandler({ db, workDir });
    const { input } = createInput(createTask({ stage: "index" }), workDir);

    const result = await handler.execute(input);

    expect(result.status).toBe("completed");
    expect(result.message).toBe("indexed");
    await expect(stat(path.join(workDir, "_downloads", "task-1.mkv"))).rejects.toThrow();
  });
});

describe("PgOnlineSupplementTaskRepository lease fencing (H2)", () => {
  interface RecordedQuery {
    text: string;
    values: readonly unknown[];
  }

  function createRecordingDb(options: { affectedRows?: number } = {}): {
    db: QueryExecutor;
    queries: RecordedQuery[];
  } {
    const queries: RecordedQuery[] = [];
    const db: QueryExecutor = {
      query: async <TRow>(text: string, values?: readonly unknown[]) => {
        queries.push({ text, values: values ?? [] });
        return {
          rows: Array.from({ length: options.affectedRows ?? 1 }, () => ({ ok: 1 })) as TRow[]
        };
      }
    };
    return { db, queries };
  }

  it("传入 workerId 时四个阶段写操作的 SQL 带租约围栏条件", async () => {
    const { db, queries } = createRecordingDb();
    const repo = new PgOnlineSupplementTaskRepository(db);
    const now = new Date("2026-08-29T00:00:00.000Z");

    await repo.updateStageProgress({
      taskId: "task-1",
      workerId: "worker-1",
      percent: 42,
      message: "half way",
      now
    });
    await repo.completeStage({ taskId: "task-1", workerId: "worker-1", nextStage: "rename", now });
    await repo.markReady({
      taskId: "task-1",
      workerId: "worker-1",
      readySongId: "song-1",
      finalFilePath: "x.mkv",
      lyricFile: null,
      now
    });
    await repo.markFailed({
      taskId: "task-1",
      workerId: "worker-1",
      failureStage: "mix",
      reason: "boom",
      now
    });

    expect(queries).toHaveLength(4);
    for (const query of queries) {
      expect(query.text).toContain("worker_id = $");
      expect(query.text).toContain("stage_status = 'running'");
      expect(query.values).toContain("worker-1");
    }
    // 围栏参数位与占位符对齐:workerId 必须落在 SQL 声明的 $N 上
    expect(queries[0]?.text).toContain("worker_id = $4");
    expect(queries[0]?.values[3]).toBe("worker-1");
    expect(queries[1]?.text).toContain("worker_id = $7");
    expect(queries[1]?.values[6]).toBe("worker-1");
    expect(queries[2]?.text).toContain("worker_id = $6");
    expect(queries[2]?.values[5]).toBe("worker-1");
    expect(queries[3]?.text).toContain("worker_id = $5");
    expect(queries[3]?.values[4]).toBe("worker-1");
  });

  it("围栏拦截(0 行受影响)时返回 null,调用方据此知道自己已失去所有权", async () => {
    // 模拟:lease 过期被 reclaimStaleLeases 回收、任务被其他 worker 重新认领后,
    // 原 worker 的 UPDATE(worker_id + running 条件)匹配不到任何行
    const { db } = createRecordingDb({ affectedRows: 0 });
    const repo = new PgOnlineSupplementTaskRepository(db);
    const now = new Date("2026-08-29T00:00:00.000Z");

    await expect(
      repo.updateStageProgress({
        taskId: "task-1",
        workerId: "worker-1",
        percent: 42,
        message: "half way",
        now
      })
    ).resolves.toBe(null);
    await expect(
      repo.completeStage({ taskId: "task-1", workerId: "worker-1", nextStage: "rename", now })
    ).resolves.toBe(null);
    await expect(
      repo.markReady({
        taskId: "task-1",
        workerId: "worker-1",
        readySongId: "song-1",
        finalFilePath: "x.mkv",
        lyricFile: null,
        now
      })
    ).resolves.toBe(null);
    await expect(
      repo.markFailed({ taskId: "task-1", workerId: "worker-1", failureStage: "mix", reason: "boom", now })
    ).resolves.toBe(null);
  });

  it("不传 workerId 时保持旧的 unfenced 行为,写入成功返回 true", async () => {
    const { db, queries } = createRecordingDb();
    const repo = new PgOnlineSupplementTaskRepository(db);
    const now = new Date("2026-08-29T00:00:00.000Z");

    await expect(
      repo.updateStageProgress({ taskId: "task-1", percent: 42, message: "half way", now })
    ).resolves.toBe(true);
    await expect(
      repo.completeStage({ taskId: "task-1", nextStage: "rename", now })
    ).resolves.toBe(true);

    expect(queries).toHaveLength(2);
    for (const query of queries) {
      expect(query.text).not.toContain("worker_id = $");
    }
  });
});

describe("DownloadStageHandler lease renewal (M3)", () => {
  it("每次下载尝试开始前续约(含首次),失败后的尝试间隔也续约", async () => {
    const workDir = await createWorkDir();
    const events: string[] = [];
    let attempt = 0;
    const provider: OnlineProvider = {
      providerId: "youtube-yt-dlp",
      search: async () => [],
      download: async () => {
        attempt += 1;
        events.push(`download-${attempt}`);
        if (attempt < 2) {
          throw new Error("flaky network");
        }
        return { filePath: "x.mkv", sizeBytes: 1, mtimeMs: 1 };
      }
    };
    const handler = new DownloadStageHandler({ provider, workDir });
    const input: StageExecuteInput = {
      task: createTask({ stage: "download" }),
      workerId: "worker-1",
      workDir,
      renewLease: async () => {
        events.push("renew");
      },
      reportProgress: async () => undefined,
      log: () => undefined
    };

    const result = await handler.execute(input);

    expect(result.status).toBe("completed");
    // renew 在每次尝试开始前(含首次)与失败后的重试间隔各出现一次,
    // 补上"首次尝试/重试开始时租约可能已过期"的续约缺口
    expect(events).toEqual(["renew", "download-1", "renew", "renew", "download-2"]);
  });
});

describe("pickDownloadArtifact", () => {
  it("排除 .part/.ytdl/.tmp 中断残留与 .fNNN 分段流残留", () => {
    expect(
      pickDownloadArtifact([
        "task-1.mp4.part",
        "task-1.mp4.part.ytdl",
        "task-1.f137.mp4",
        "task-1.f139.m4a",
        "task-1.tmp.webm"
      ])
    ).toBeNull();
  });

  it("只认媒体扩展名白名单,非媒体扩展名返回 null", () => {
    expect(pickDownloadArtifact(["task-1.jpg", "task-1.txt", "task-1.json"])).toBeNull();
    expect(pickDownloadArtifact(["task-1.part"])).toBeNull();
  });

  it("按扩展名优先级挑选:mkv > mp4 > webm > m4a", () => {
    expect(pickDownloadArtifact(["task-1.m4a", "task-1.webm", "task-1.mp4", "task-1.mkv"]))
      .toBe("task-1.mkv");
    expect(pickDownloadArtifact(["task-1.m4a", "task-1.webm", "task-1.mp4"])).toBe("task-1.mp4");
    expect(pickDownloadArtifact(["task-1.m4a", "task-1.webm"])).toBe("task-1.webm");
    expect(pickDownloadArtifact(["task-1.m4a"])).toBe("task-1.m4a");
  });

  it("忽略半截残留,只从完整媒体产物里挑", () => {
    expect(pickDownloadArtifact(["task-1.mp4.part", "task-1.webm"])).toBe("task-1.webm");
    // 同优先级保持输入顺序先到先得
    expect(pickDownloadArtifact(["task-1.mp4", "task-1.mp4"])).toBe("task-1.mp4");
  });
});

describe("YtDlpProvider download artifact handling (H1)", () => {
  function downloadInput(workDir: string): OnlineDownloadInput {
    return {
      candidate: {
        provider: "youtube-yt-dlp",
        providerCandidateId: "vid-1",
        sourceUrl: "https://www.youtube.com/watch?v=vid-1",
        title: "Some Official MV",
        artistName: "Some Artist",
        durationMs: 240000,
        providerPayload: {}
      },
      destPath: path.join(workDir, "_downloads", "task-1.mkv")
    };
  }

  // 从 yt-dlp 参数里的 -o 输出模板解析产物目录,把模拟文件写到那里
  function outputDirFromArgs(args: readonly string[]): string {
    const outIndex = args.indexOf("-o");
    const template = outIndex >= 0 ? (args[outIndex + 1] ?? "") : "";
    return path.dirname(template);
  }

  it("忽略更大的 .part/分段残留,挑完整媒体产物改名入库并清理残留", async () => {
    const workDir = await createWorkDir();
    const downloadsDir = path.join(workDir, "_downloads");
    await mkdir(downloadsDir, { recursive: true });
    const provider = new YtDlpProvider({
      run: async (_bin, args) => {
        const dir = outputDirFromArgs(args);
        // 半截 .part 故意比完整文件大,分段 m4a 是 adaptive 流残留
        await writeFile(path.join(dir, "task-1.mp4"), "complete-video");
        await writeFile(path.join(dir, "task-1.mp4.part"), "x".repeat(10_000));
        await writeFile(path.join(dir, "task-1.f139.m4a"), "audio-segment");
        return "";
      }
    });

    const result = await provider.download(downloadInput(workDir));

    expect(result.filePath).toBe(path.join(downloadsDir, "task-1.mkv"));
    expect(result.sizeBytes).toBe("complete-video".length);
    const { readFile } = await import("node:fs/promises");
    await expect(readFile(path.join(downloadsDir, "task-1.mkv"), "utf8"))
      .resolves.toBe("complete-video");
    await expect(stat(path.join(downloadsDir, "task-1.mp4.part"))).rejects.toThrow();
    await expect(stat(path.join(downloadsDir, "task-1.f139.m4a"))).rejects.toThrow();
  });

  it("扩展名优先级优先于体积:小 mp4 战胜大 webm", async () => {
    const workDir = await createWorkDir();
    const downloadsDir = path.join(workDir, "_downloads");
    await mkdir(downloadsDir, { recursive: true });
    const provider = new YtDlpProvider({
      run: async (_bin, args) => {
        const dir = outputDirFromArgs(args);
        await writeFile(path.join(dir, "task-1.mp4"), "mp4-priority");
        await writeFile(path.join(dir, "task-1.webm"), "w".repeat(10_000));
        return "";
      }
    });

    const result = await provider.download(downloadInput(workDir));

    const { readFile } = await import("node:fs/promises");
    await expect(readFile(path.join(downloadsDir, "task-1.mkv"), "utf8"))
      .resolves.toBe("mp4-priority");
    await expect(stat(path.join(downloadsDir, "task-1.webm"))).rejects.toThrow();
    expect(result.sizeBytes).toBe("mp4-priority".length);
  });

  it("只产出半截 .part 时判定失败抛错,不把残留当交付物", async () => {
    const workDir = await createWorkDir();
    await mkdir(path.join(workDir, "_downloads"), { recursive: true });
    const provider = new YtDlpProvider({
      run: async (_bin, args) => {
        const dir = outputDirFromArgs(args);
        await writeFile(path.join(dir, "task-1.mp4.part"), "half-downloaded");
        return "";
      }
    });

    await expect(provider.download(downloadInput(workDir))).rejects.toThrow(/no fresh file/);
  });

  it("下载无产物时删除旧的 destPath,不让上一轮旧文件复活成本次成功", async () => {
    const workDir = await createWorkDir();
    const downloadsDir = path.join(workDir, "_downloads");
    await mkdir(downloadsDir, { recursive: true });
    const destPath = path.join(downloadsDir, "task-1.mkv");
    await writeFile(destPath, "previous-run-file");
    // 旧文件的 mtime 早于本次下载起点
    const stale = new Date(Date.now() - 120_000);
    await utimes(destPath, stale, stale);
    const provider = new YtDlpProvider({ run: async () => "" });

    await expect(provider.download(downloadInput(workDir))).rejects.toThrow(/no fresh file/);
    await expect(stat(destPath)).rejects.toThrow();
  });

  it("yt-dlp 直出 mkv(destPath 本名)时无需改名,直接校验通过", async () => {
    const workDir = await createWorkDir();
    const downloadsDir = path.join(workDir, "_downloads");
    await mkdir(downloadsDir, { recursive: true });
    const provider = new YtDlpProvider({
      run: async (_bin, args) => {
        const dir = outputDirFromArgs(args);
        await writeFile(path.join(dir, "task-1.mkv"), "direct-mkv");
        return "";
      }
    });

    const result = await provider.download(downloadInput(workDir));

    expect(result.filePath).toBe(path.join(downloadsDir, "task-1.mkv"));
    expect(result.sizeBytes).toBe("direct-mkv".length);
    expect(result.mtimeMs).not.toBeNull();
  });
});
