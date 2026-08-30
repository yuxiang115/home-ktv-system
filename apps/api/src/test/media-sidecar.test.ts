import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OnlineSupplementTask } from "@home-ktv/domain";
import { activeChildPids } from "../modules/online-supplement/process-runner.js";
import {
  encodeSidecarRequest,
  parseSidecarLine,
  PythonSidecar,
  SidecarTransportError,
  type SidecarResponse
} from "../modules/online-supplement/python-sidecar.js";
import { AlignStageHandler } from "../modules/online-supplement/handlers/align-handler.js";
import { VocalRemoveStageHandler } from "../modules/online-supplement/handlers/vocal-remove-handler.js";
import type { StageExecuteInput } from "../modules/online-supplement/supplement-orchestrator.js";

// ---- 测试基建 -----------------------------------------------------------

interface ParsedSidecarRequest {
  id: number;
  cmd: string;
  args: Record<string, unknown>;
}

// 假 sidecar 子进程:stdin 收协议行 → handler 生成应答 → stdout 回协议行。
// 用 PassThrough 模拟 stdio 流,不触真实进程。
class FakeSidecarChild {
  private static nextPid = 950_001;

  readonly pid: number;
  readonly child: ChildProcess;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: ParsedSidecarRequest[] = [];
  private readonly delegate = new EventEmitter();
  killed = false;

  /** 当前应答策略:返回 response 则回写;返回 null 则挂起(模拟无响应)。
   *  支持 async(应答前先落盘产物,避免与 handler 的产物校验竞态)。 */
  handler: (request: ParsedSidecarRequest) => SidecarResponse | null | Promise<SidecarResponse | null> = () => ({
    id: 0,
    ok: true,
    result: {}
  });

  constructor() {
    this.pid = FakeSidecarChild.nextPid;
    FakeSidecarChild.nextPid += 1;
    this.stdin.on("data", (chunk: Buffer) => {
      void (async () => {
        for (const line of chunk.toString("utf8").split(/\r?\n/u).filter(Boolean)) {
          const request = JSON.parse(line) as ParsedSidecarRequest;
          this.requests.push(request);
          const response = await this.handler(request);
          if (response) {
            this.stdout.write(`${JSON.stringify({ ...response, id: request.id })}\n`);
          }
        }
      })();
    });
    this.child = this.delegate as unknown as ChildProcess;
    Object.defineProperties(this.child, {
      pid: { value: this.pid },
      stdin: { value: this.stdin },
      stdout: { value: this.stdout },
      stderr: { value: this.stderr },
      kill: { value: () => {
        this.killed = true;
      } }
    });
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.delegate.emit("exit", code, signal);
  }

  emitError(error: Error): void {
    this.delegate.emit("error", error);
  }
}

interface SidecarHarness {
  sidecar: PythonSidecar;
  children: FakeSidecarChild[];
  kills: number[];
  spawnCount(): number;
}

function createSidecarHarness(options: {
  maxConsecutiveCrashes?: number;
  onSpawn?: (child: FakeSidecarChild) => void;
} = {}): SidecarHarness {
  const children: FakeSidecarChild[] = [];
  const kills: number[] = [];
  const sidecar = new PythonSidecar({
    bin: "python-fake",
    scriptPath: "python/media_sidecar.py",
    spawnImpl: () => {
      const child = new FakeSidecarChild();
      children.push(child);
      options.onSpawn?.(child);
      return child.child;
    },
    killImpl: async (pid) => {
      kills.push(pid);
    },
    ...(options.maxConsecutiveCrashes !== undefined
      ? { maxConsecutiveCrashes: options.maxConsecutiveCrashes }
      : {})
  });
  return {
    sidecar,
    children,
    kills,
    spawnCount: () => children.length
  };
}

const tempDirs: string[] = [];

async function createWorkDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "home-ktv-sidecar-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  activeChildPids.clear();
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
    stage: "align",
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

function createInput(task: OnlineSupplementTask, workDir: string): StageExecuteInput {
  return {
    task,
    workerId: "worker-1",
    workDir,
    renewLease: async () => undefined,
    reportProgress: async () => undefined,
    log: () => undefined
  };
}

async function prepareAlignInputs(workDir: string): Promise<void> {
  const vocalsDir = path.join(workDir, "_stems", "task-1", "htdemucs", "task-1");
  await mkdir(vocalsDir, { recursive: true });
  await writeFile(path.join(vocalsDir, "vocals.wav"), "pcm");
  await mkdir(path.join(workDir, "_lyrics"), { recursive: true });
  await writeFile(path.join(workDir, "_lyrics", "task-1.lrc"), "[00:10.00]测试\n", "utf8");
}

function validKaraokePayload(): string {
  return JSON.stringify({
    lines: [{ start: 10, end: 12, text: "测试", words: [{ text: "测", start: 10, end: 11 }] }]
  });
}

// ---- 协议编解码 ---------------------------------------------------------

describe("sidecar protocol codec", () => {
  it("encodeSidecarRequest 产出单行 JSON(id/cmd/args)并以换行结尾", () => {
    const line = encodeSidecarRequest(7, "align", { audio: "a.wav", language: "Chinese" });

    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual({
      id: 7,
      cmd: "align",
      args: { audio: "a.wav", language: "Chinese" }
    });
  });

  it("parseSidecarLine 解析成功/失败应答", () => {
    expect(parseSidecarLine('{"id":3,"ok":true,"result":{"lines":5}}')).toEqual({
      id: 3,
      ok: true,
      result: { lines: 5 }
    });
    expect(parseSidecarLine('{"id":4,"ok":false,"error":"boom"}')).toEqual({
      id: 4,
      ok: false,
      error: "boom"
    });
  });

  it("parseSidecarLine 拒绝非 JSON/非对象/缺 ok 字段的行(迟到噪声不致崩)", () => {
    expect(parseSidecarLine("")).toBeNull();
    expect(parseSidecarLine("   ")).toBeNull();
    expect(parseSidecarLine("not json")).toBeNull();
    expect(parseSidecarLine("[1,2]")).toBeNull();
    expect(parseSidecarLine('{"id":1}')).toBeNull();
  });
});

// ---- 客户端状态机 -------------------------------------------------------

describe("PythonSidecar 状态机", () => {
  it("懒启动:构造不 spawn,首个请求才 spawn 并按 id 配对应答", async () => {
    const harness = createSidecarHarness();
    expect(harness.spawnCount()).toBe(0);

    const response = await harness.sidecar.ping(2000);

    expect(response.ok).toBe(true);
    expect(harness.spawnCount()).toBe(1);
    expect(harness.children[0]?.requests[0]?.cmd).toBe("ping");
    // pid 已登记 activeChildPids(worker 优雅退出树杀复用该机制)
    expect(activeChildPids.has(harness.children[0]?.pid ?? -1)).toBe(true);
  });

  it("业务失败(ok:false)resolve 而非 reject——交给 handler 按旧路径语义处理", async () => {
    const harness = createSidecarHarness({
      onSpawn: (child) => {
        child.handler = () => ({ id: 0, ok: false, error: "no timestamped lyrics; skip" });
      }
    });

    const response = await harness.sidecar.align(
      { audio: "a", lyrics: "b", out: "c", language: "Chinese", model: "m", device: "cuda:0", dtype: "bfloat16" },
      2000
    );

    expect(response).toEqual({ id: 1, ok: false, error: "no timestamped lyrics; skip" });
  });

  it("demucs 请求透传 demucsBin/demucsArgs 作为 CLI 回退参数", async () => {
    const children: FakeSidecarChild[] = [];
    const sidecar = new PythonSidecar({
      bin: "python-fake",
      scriptPath: "python/media_sidecar.py",
      demucsBin: "demucs.exe",
      demucsArgs: "-m demucs",
      spawnImpl: () => {
        const child = new FakeSidecarChild();
        children.push(child);
        return child.child;
      },
      killImpl: async () => undefined
    });

    await sidecar.demucs({ audio: "a.wav", outDir: "o", model: "htdemucs", device: "cuda" }, 2000);

    const request = children[0]?.requests[0];
    expect(request?.cmd).toBe("demucs");
    expect(request?.args.fallbackBin).toBe("demucs.exe");
    expect(request?.args.binArgs).toBe("-m demucs");
  });

  it("单请求超时:reject 传输错误并树杀 sidecar", async () => {
    const harness = createSidecarHarness({
      onSpawn: (child) => {
        child.handler = () => null; // 永不响应
      }
    });

    await expect(harness.sidecar.ping(80)).rejects.toThrow(SidecarTransportError);
    expect(harness.kills).toEqual([harness.children[0]?.pid]);
  }, 10_000);

  it("进程崩溃:在途请求 reject 传输错误,下一次请求自动重启新进程", async () => {
    let crashNext = true;
    const harness = createSidecarHarness({
      onSpawn: (child) => {
        child.handler = () => {
          if (crashNext) {
            // 应答前先崩(非零退出 + 有在途请求 → 计一次崩溃)
            queueMicrotask(() => child.emitExit(1, null));
            crashNext = false;
            return null;
          }
          return { id: 0, ok: true, result: { pong: true } };
        };
      }
    });

    await expect(harness.sidecar.ping(2000)).rejects.toThrow(/exited unexpectedly/u);
    const response = await harness.sidecar.ping(2000);

    expect(response.ok).toBe(true);
    expect(harness.spawnCount()).toBe(2);
  });

  it("连续崩溃 3 次后标记 broken:后续请求立即 reject 且不再 spawn", async () => {
    const harness = createSidecarHarness({
      onSpawn: (child) => {
        child.handler = () => {
          queueMicrotask(() => child.emitExit(1, null));
          return null;
        };
      }
    });

    for (let i = 0; i < 3; i += 1) {
      await expect(harness.sidecar.ping(2000)).rejects.toThrow(SidecarTransportError);
    }
    expect(harness.sidecar.isBroken()).toBe(true);

    // broken 后直接拒绝,不再起第 4 个进程 → 调用方回退旧路径
    await expect(harness.sidecar.ping(2000)).rejects.toThrow(/broken/u);
    expect(harness.spawnCount()).toBe(3);
  });

  it("成功应答会清零连续崩溃计数", async () => {
    // 崩溃 2 次 → 成功 1 次(计数清零)→ 再崩溃 2 次:始终未达 3 连崩,不 broken
    const crashIndices = new Set([0, 1, 3]);
    let spawnIndex = 0;
    const harness = createSidecarHarness({
      onSpawn: (child) => {
        const index = spawnIndex;
        spawnIndex += 1;
        child.handler = () => {
          if (crashIndices.has(index)) {
            queueMicrotask(() => child.emitExit(1, null));
            return null;
          }
          return { id: 0, ok: true, result: {} };
        };
      }
    });

    await expect(harness.sidecar.ping(2000)).rejects.toThrow(SidecarTransportError);
    await expect(harness.sidecar.ping(2000)).rejects.toThrow(SidecarTransportError);
    expect(await harness.sidecar.ping(2000)).toEqual({ id: 3, ok: true, result: {} });
    // 健康进程空闲时异常退出(非零码):计 1 次崩溃,但仍未到 3 连
    harness.children[2]?.emitExit(1, null);
    await expect(harness.sidecar.ping(2000)).rejects.toThrow(SidecarTransportError);
    expect(harness.sidecar.isBroken()).toBe(false);
    // 下一个进程仍正常服务
    expect(await harness.sidecar.ping(2000)).toEqual({ id: 5, ok: true, result: {} });
    expect(harness.sidecar.isBroken()).toBe(false);
  });

  it("空闲退出(code=0 且无在途请求)不算崩溃:python 30min 自杀后仍可重启", async () => {
    const harness = createSidecarHarness();

    for (let round = 0; round < 3; round += 1) {
      expect(await harness.sidecar.ping(2000)).toEqual(expect.objectContaining({ ok: true }));
      harness.children[round]?.emitExit(0, null); // 模拟 python 侧空闲自杀
    }

    expect(harness.sidecar.isBroken()).toBe(false);
    expect(await harness.sidecar.ping(2000)).toEqual(expect.objectContaining({ ok: true }));
    expect(harness.spawnCount()).toBe(4);
  });

  it("shutdown:树杀进程、注销 pid、清空状态(下次请求重新懒启动)", async () => {
    const harness = createSidecarHarness();
    await harness.sidecar.ping(2000);
    const pid = harness.children[0]?.pid;

    await harness.sidecar.shutdown();

    expect(harness.kills).toEqual([pid]);
    expect(activeChildPids.has(pid ?? -1)).toBe(false);
    expect(await harness.sidecar.ping(2000)).toEqual(expect.objectContaining({ ok: true }));
    expect(harness.spawnCount()).toBe(2);
  });

  it("spawn 工厂抛错时以传输错误 reject(调用方回退旧路径)", async () => {
    const sidecar = new PythonSidecar({
      bin: "python-fake",
      scriptPath: "python/media_sidecar.py",
      spawnImpl: () => {
        throw new Error("spawn ENOENT");
      },
      killImpl: async () => undefined
    });

    await expect(sidecar.ping(2000)).rejects.toThrow(/spawn failed: spawn ENOENT/u);
  });
});

// ---- align 阶段接入 -----------------------------------------------------

describe("AlignStageHandler sidecar 接入", () => {
  const handlerOptions = {
    bin: "python.exe",
    scriptPath: "python/align_lyrics.py",
    model: "Qwen/Qwen3-ForcedAligner-0.6B",
    device: "cuda:0",
    dtype: "bfloat16",
    demucsModel: "htdemucs"
  };

  it("sidecar 可用时优先走 sidecar,不再起单次脚本进程", async () => {
    const workDir = await createWorkDir();
    await prepareAlignInputs(workDir);
    const harness = createSidecarHarness({
      onSpawn: (child) => {
        child.handler = async (request) => {
          const out = String(request.args.out ?? "");
          await mkdir(path.dirname(out), { recursive: true });
          await writeFile(out, validKaraokePayload(), "utf8");
          return { id: 0, ok: true, result: { lines: 1 } };
        };
      }
    });
    const handler = new AlignStageHandler({
      ...handlerOptions,
      sidecar: harness.sidecar,
      run: async () => {
        throw new Error("should not run the one-shot path");
      }
    });

    const result = await handler.execute(createInput(createTask({ stage: "align" }), workDir));

    expect(result.status).toBe("completed");
    expect(result.message).toBe("aligned");
    expect(harness.children[0]?.requests[0]?.cmd).toBe("align");
    expect(harness.children[0]?.requests[0]?.args).toMatchObject({
      language: "Chinese",
      model: handlerOptions.model,
      device: handlerOptions.device,
      dtype: handlerOptions.dtype
    });
  });

  it("sidecar 业务失败(ok:false)沿用旧路径语义:best-effort 完成 + lrc 兜底", async () => {
    const workDir = await createWorkDir();
    await prepareAlignInputs(workDir);
    const harness = createSidecarHarness({
      onSpawn: (child) => {
        child.handler = () => ({ id: 0, ok: false, error: "no timestamped lyrics; skip" });
      }
    });
    const handler = new AlignStageHandler({
      ...handlerOptions,
      sidecar: harness.sidecar,
      run: async () => {
        throw new Error("should not run the one-shot path");
      }
    });

    const result = await handler.execute(createInput(createTask({ stage: "align" }), workDir));

    expect(result.status).toBe("completed");
    expect(result.message).toContain("align failed (best-effort, lrc fallback)");
    expect(result.message).toContain("no timestamped lyrics");
  });

  it("sidecar 传输层故障时回退单次脚本路径", async () => {
    const workDir = await createWorkDir();
    await prepareAlignInputs(workDir);
    const harness = createSidecarHarness({
      onSpawn: (child) => {
        child.handler = () => {
          queueMicrotask(() => child.emitExit(1, null));
          return null;
        };
      }
    });
    const calls: string[][] = [];
    const handler = new AlignStageHandler({
      ...handlerOptions,
      sidecar: harness.sidecar,
      run: async (_bin, args) => {
        calls.push([...args]);
        const outIndex = args.indexOf("--out");
        const out = outIndex >= 0 ? (args[outIndex + 1] ?? "") : "";
        await mkdir(path.dirname(out), { recursive: true });
        await writeFile(out, validKaraokePayload(), "utf8");
      }
    });

    const result = await handler.execute(createInput(createTask({ stage: "align" }), workDir));

    expect(result.status).toBe("completed");
    expect(result.message).toBe("aligned");
    expect(calls).toHaveLength(1);
  });

  it("sidecar 已 broken 时直接走单次脚本路径", async () => {
    const workDir = await createWorkDir();
    await prepareAlignInputs(workDir);
    const harness = createSidecarHarness({
      onSpawn: (child) => {
        child.handler = () => {
          queueMicrotask(() => child.emitExit(1, null));
          return null;
        };
      }
    });
    for (let i = 0; i < 3; i += 1) {
      await expect(harness.sidecar.ping(2000)).rejects.toThrow(SidecarTransportError);
    }
    expect(harness.sidecar.isBroken()).toBe(true);
    const spawnsBefore = harness.spawnCount();

    const handler = new AlignStageHandler({
      ...handlerOptions,
      sidecar: harness.sidecar,
      run: async (_bin, args) => {
        const outIndex = args.indexOf("--out");
        const out = outIndex >= 0 ? (args[outIndex + 1] ?? "") : "";
        await mkdir(path.dirname(out), { recursive: true });
        await writeFile(out, validKaraokePayload(), "utf8");
      }
    });

    const result = await handler.execute(createInput(createTask({ stage: "align" }), workDir));

    expect(result.message).toBe("aligned");
    expect(harness.spawnCount()).toBe(spawnsBefore);
  });
});

// ---- vocal_remove 阶段接入 ----------------------------------------------

describe("VocalRemoveStageHandler sidecar 接入", () => {
  async function prepareDownload(workDir: string): Promise<void> {
    await mkdir(path.join(workDir, "_downloads"), { recursive: true });
    await writeFile(path.join(workDir, "_downloads", "task-1.mkv"), "video");
  }

  function sidecarWritingDemucs() {
    return (child: FakeSidecarChild): void => {
      child.handler = async (request) => {
        const outDir = String(request.args.outDir ?? "");
        const model = String(request.args.model ?? "htdemucs");
        const stemDir = path.join(outDir, model, "task-1");
        await mkdir(stemDir, { recursive: true });
        await writeFile(path.join(stemDir, "no_vocals.wav"), "pcm");
        await writeFile(path.join(stemDir, "vocals.wav"), "pcm");
        return { id: 0, ok: true, result: { via: "python-api", files: [] } };
      };
    };
  }

  it("sidecar 可用时优先复用模型,产物校验沿用 CLI 布局约定", async () => {
    const workDir = await createWorkDir();
    await prepareDownload(workDir);
    const harness = createSidecarHarness({ onSpawn: sidecarWritingDemucs() });
    const handler = new VocalRemoveStageHandler({
      bin: "demucs",
      device: "cuda",
      model: "htdemucs",
      workDir,
      sidecar: harness.sidecar,
      run: async () => {
        throw new Error("should not run the CLI path");
      }
    });

    const result = await handler.execute(createInput(createTask({ stage: "vocal_remove" }), workDir));

    expect(result.status).toBe("completed");
    expect(result.message).toBe("vocal removed");
    expect(harness.children[0]?.requests[0]?.cmd).toBe("demucs");
    expect(harness.children[0]?.requests[0]?.args).toMatchObject({
      model: "htdemucs",
      device: "cuda"
    });
  });

  it("sidecar 业务失败与 CLI 非零退出同语义:重试 2 次后 failed", async () => {
    const workDir = await createWorkDir();
    await prepareDownload(workDir);
    const harness = createSidecarHarness({
      onSpawn: (child) => {
        child.handler = () => ({ id: 0, ok: false, error: "model load failed" });
      }
    });
    const handler = new VocalRemoveStageHandler({
      bin: "demucs",
      device: "cpu",
      model: "htdemucs",
      workDir,
      timeoutMs: 1000,
      sidecar: harness.sidecar,
      run: async () => {
        throw new Error("should not run the CLI path");
      }
    });

    const result = await handler.execute(createInput(createTask({ stage: "vocal_remove" }), workDir));

    expect(result.status).toBe("failed");
    expect(result.failureReason).toContain("demucs failed: model load failed");
    expect(harness.children.flatMap((child) => child.requests.filter((r) => r.cmd === "demucs"))).toHaveLength(2);
  }, 15_000);

  it("sidecar 传输层故障时同一次尝试内回退 CLI", async () => {
    const workDir = await createWorkDir();
    await prepareDownload(workDir);
    const harness = createSidecarHarness({
      onSpawn: (child) => {
        child.handler = () => {
          queueMicrotask(() => child.emitExit(1, null));
          return null;
        };
      }
    });
    const cliCalls: string[][] = [];
    const handler = new VocalRemoveStageHandler({
      bin: "demucs",
      device: "cpu",
      model: "htdemucs",
      workDir,
      timeoutMs: 1000,
      sidecar: harness.sidecar,
      run: async (_bin, args) => {
        cliCalls.push([...args]);
        const outDir = args[args.indexOf("-o") + 1] ?? "";
        const model = args[args.indexOf("-n") + 1] ?? "";
        await mkdir(path.join(outDir, model, "task-1"), { recursive: true });
        await writeFile(path.join(outDir, model, "task-1", "no_vocals.wav"), "pcm");
      }
    });

    const result = await handler.execute(createInput(createTask({ stage: "vocal_remove" }), workDir));

    expect(result.status).toBe("completed");
    expect(result.message).toBe("vocal removed");
    expect(cliCalls).toHaveLength(1);
  }, 15_000);

  it("sidecar 已 broken 时直接走 CLI 路径", async () => {
    const workDir = await createWorkDir();
    await prepareDownload(workDir);
    const harness = createSidecarHarness({
      onSpawn: (child) => {
        child.handler = () => {
          queueMicrotask(() => child.emitExit(1, null));
          return null;
        };
      }
    });
    for (let i = 0; i < 3; i += 1) {
      await expect(harness.sidecar.ping(2000)).rejects.toThrow(SidecarTransportError);
    }
    const spawnsBefore = harness.spawnCount();

    const handler = new VocalRemoveStageHandler({
      bin: "demucs",
      device: "cpu",
      model: "htdemucs",
      workDir,
      sidecar: harness.sidecar,
      run: async (_bin, args) => {
        const outDir = args[args.indexOf("-o") + 1] ?? "";
        const model = args[args.indexOf("-n") + 1] ?? "";
        await mkdir(path.join(outDir, model, "task-1"), { recursive: true });
        await writeFile(path.join(outDir, model, "task-1", "no_vocals.wav"), "pcm");
      }
    });

    const result = await handler.execute(createInput(createTask({ stage: "vocal_remove" }), workDir));

    expect(result.status).toBe("completed");
    expect(harness.spawnCount()).toBe(spawnsBefore);
  });
});
