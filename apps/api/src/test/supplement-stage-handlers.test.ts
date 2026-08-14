import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OnlineSupplementTask } from "@home-ktv/domain";
import type { StageExecuteInput } from "../modules/online-supplement/supplement-orchestrator.js";
import {
  LyricsStageHandler,
  supplementSearchNames
} from "../modules/online-supplement/handlers/lyrics-handler.js";
import { fallbackSpecName } from "../modules/online-supplement/handlers/rename-llm-handler.js";
import { VocalRemoveStageHandler } from "../modules/online-supplement/handlers/vocal-remove-handler.js";
import { MixStageHandler } from "../modules/online-supplement/handlers/mix-handler.js";

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
}

function createInput(task: OnlineSupplementTask, workDir: string): InputHarness {
  const leaseCalls: Date[] = [];
  const progressCalls: Array<{ percent: number; message: string }> = [];
  const input: StageExecuteInput = {
    task,
    workerId: "worker-1",
    workDir,
    renewLease: async (leaseUntil) => {
      leaseCalls.push(leaseUntil);
    },
    reportProgress: async (percent, message) => {
      progressCalls.push({ percent, message });
    }
  };
  return { input, leaseCalls, progressCalls };
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
