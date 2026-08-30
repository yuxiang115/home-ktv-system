import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import {
  activeChildPids,
  buildTreeKillCommand,
  defaultStageCommandRunner,
  runStageCommand
} from "../modules/online-supplement/handlers/vocal-remove-handler.js";
import {
  isEnvironmentSpawnFailure,
  trimFailureMessage,
  YtDlpProvider
} from "../modules/online-supplement/providers/yt-dlp-provider.js";

// child_process.spawn 的 ESM namespace 不可配置,无法 vi.spyOn,这里用 vi.mock:
// 默认透传真实 spawn(跑真实进程的行为测试),需要时把 harness.impl 换成 fake
// (只 fake 目标子进程与 taskkill,不触真实进程)。
type FakeSpawnImpl = (command: string, args: readonly string[], options?: SpawnOptions) => ChildProcess;

const spawnHarness = vi.hoisted(() => {
  return {
    impl: null as FakeSpawnImpl | null,
    calls: [] as Array<{ command: string; args: string[]; options: SpawnOptions }>
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((command: string, args: readonly string[], options?: SpawnOptions) => {
      spawnHarness.calls.push({ command, args: [...args], options: options ?? ({} as SpawnOptions) });
      if (spawnHarness.impl) {
        return spawnHarness.impl(command, args, options);
      }
      return actual.spawn(command, args as string[], options ?? {});
    }) as typeof actual.spawn
  };
});

interface FakeChild {
  pid: number;
  child: ChildProcess;
  emitStdout: (text: string) => void;
  emitStderr: (text: string) => void;
  emitClose: (code: number | null, signal: NodeJS.Signals | null) => void;
}

function createFakeChild(pid: number): FakeChild {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const delegate = new EventEmitter();
  const child = delegate as unknown as ChildProcess;
  Object.defineProperties(child, {
    pid: { value: pid },
    stdout: { value: stdout },
    stderr: { value: stderr },
    kill: { value: () => true }
  });
  return {
    pid,
    child,
    emitStdout: (text) => stdout.emit("data", Buffer.from(text)),
    emitStderr: (text) => stderr.emit("data", Buffer.from(text)),
    emitClose: (code, signal) => delegate.emit("close", code, signal)
  };
}

// process.platform 是可配置属性,可临时改写以覆盖 win32/POSIX 分支;
// finally 里恢复原 descriptor。
async function withPlatform<R>(platform: NodeJS.Platform, fn: () => Promise<R>): Promise<R> {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return await fn();
  } finally {
    if (original) {
      Object.defineProperty(process, "platform", original);
    }
  }
}

afterEach(() => {
  spawnHarness.impl = null;
  spawnHarness.calls.length = 0;
  activeChildPids.clear();
  vi.restoreAllMocks();
});

describe("buildTreeKillCommand", () => {
  it("win32 拼 taskkill /PID <pid> /T /F(递归杀整棵进程树)", () => {
    expect(buildTreeKillCommand(1234, "win32")).toEqual({
      command: "taskkill",
      args: ["/PID", "1234", "/T", "/F"]
    });
  });

  it("POSIX 返回 null(由调用方对 detached 进程组 kill(-pid))", () => {
    expect(buildTreeKillCommand(1234, "linux")).toBeNull();
    expect(buildTreeKillCommand(1234, "darwin")).toBeNull();
  });
});

describe("defaultStageCommandRunner (真实 spawn 透传)", () => {
  it("成功时 resolve {stdout, stderr},spawn 带 windowsHide:true", async () => {
    const result = await defaultStageCommandRunner(
      process.execPath,
      ["-e", "process.stdout.write('out-42'); process.stderr.write('err-42')"],
      10_000
    );

    expect(result).toEqual({ stdout: "out-42", stderr: "err-42" });
    const options = spawnHarness.calls.at(-1)?.options;
    expect(options?.windowsHide).toBe(true);
  });

  it("非零退出码 reject 且 message 保留 exit=3(下游 trimFailureMessage 可命中)", async () => {
    const error: Error | null = await defaultStageCommandRunner(
      process.execPath,
      ["-e", "process.exit(3)"],
      10_000
    ).then(
      () => null,
      (e: Error) => e
    );

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("Command failed:");
    expect(error?.message).toMatch(/exit=3/u);
    // 兼容确认:yt-dlp-provider 按 "exit=数字" 截取关键信息
    expect(trimFailureMessage(error?.message ?? "")).toMatch(/exit=3/u);
  });

  it("超时树杀后 reject 并标注 killed(timeout=...),pid 登记随之清理", async () => {
    const error: Error | null = await defaultStageCommandRunner(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      150
    ).then(
      () => null,
      (e: Error) => e
    );

    expect(error?.message).toMatch(/killed\(timeout=150ms\)/u);
    expect(activeChildPids.size).toBe(0);
  }, 15_000);

  it("spawn 阶段失败保留原生错误(message 含 ENOENT,供 isEnvironmentSpawnFailure 分类)", async () => {
    const error: Error | null = await defaultStageCommandRunner(
      "definitely-missing-binary-xyz",
      [],
      1000
    ).then(
      () => null,
      (e: Error) => e
    );

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/ENOENT/u);
    expect(isEnvironmentSpawnFailure(error?.message ?? "")).toBe(true);
    expect(activeChildPids.size).toBe(0);
  });
});

describe("defaultStageCommandRunner (fake spawn:平台分支)", () => {
  it("win32:windowsHide:true 且不传 detached;pid 登记/注销随 spawn/close", async () => {
    await withPlatform("win32", async () => {
      const holder: { fake: FakeChild | null } = { fake: null };
      spawnHarness.impl = () => {
        holder.fake = createFakeChild(900_001);
        return holder.fake.child;
      };

      const promise = defaultStageCommandRunner("demucs", ["-n", "htdemucs"], 10_000);

      expect(spawnHarness.calls[0]?.options.windowsHide).toBe(true);
      expect(spawnHarness.calls[0]?.options.detached).toBeUndefined();
      expect(activeChildPids.has(900_001)).toBe(true);

      holder.fake?.emitClose(0, null);
      await expect(promise).resolves.toEqual({ stdout: "", stderr: "" });
      expect(activeChildPids.has(900_001)).toBe(false);
    });
  });

  it("win32:成功时收集 stdout/stderr;非零退出码 reject 且 message 含 exit=7", async () => {
    await withPlatform("win32", async () => {
      const holder: { fake: FakeChild | null } = { fake: null };
      spawnHarness.impl = () => {
        holder.fake = createFakeChild(900_005);
        return holder.fake.child;
      };

      const promise = defaultStageCommandRunner("tool", ["--flag"], 10_000);
      holder.fake?.emitStdout("so-");
      holder.fake?.emitStdout("me");
      holder.fake?.emitStderr("warn");
      holder.fake?.emitClose(7, null);

      await expect(promise).rejects.toThrow(/exit=7/u);
    });
  });

  it("win32:0xC0000142(3221225794) 等环境故障退出码可被下游分类器识别", async () => {
    await withPlatform("win32", async () => {
      const holder: { fake: FakeChild | null } = { fake: null };
      spawnHarness.impl = () => {
        holder.fake = createFakeChild(900_006);
        return holder.fake.child;
      };

      const promise = defaultStageCommandRunner("tool", [], 10_000);
      holder.fake?.emitStderr("dll init failed");
      holder.fake?.emitClose(3221225794, null);

      const error: Error = await promise.then(
        () => {
          throw new Error("expected rejection");
        },
        (e: Error) => e
      );
      expect(error.message).toMatch(/exit=3221225794/u);
      expect(isEnvironmentSpawnFailure(error.message)).toBe(true);
      expect(trimFailureMessage(error.message)).toMatch(/exit=3221225794/u);
    });
  });

  it("win32:超时先 spawn taskkill /PID <pid> /T /F,再 child.kill 兜底", async () => {
    await withPlatform("win32", async () => {
      const holder: { fake: FakeChild | null } = { fake: null };
      spawnHarness.impl = () => {
        if (holder.fake) {
          // 第二次调用是 killProcessTree 的 taskkill:返回会自行结束的 fake
          const killer = createFakeChild(900_002);
          queueMicrotask(() => killer.emitClose(1, null));
          return killer.child;
        }
        holder.fake = createFakeChild(900_003);
        return holder.fake.child;
      };

      const promise = defaultStageCommandRunner("demucs", [], 20);
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(spawnHarness.calls).toHaveLength(2);
      expect(spawnHarness.calls[1]?.command).toBe("taskkill");
      expect(spawnHarness.calls[1]?.args).toEqual(["/PID", "900003", "/T", "/F"]);

      holder.fake?.emitClose(null, null);
      await expect(promise).rejects.toThrow(/killed\(timeout=20ms\)/u);
      expect(activeChildPids.has(900_003)).toBe(false);
    });
  });

  it("POSIX:windowsHide:true + detached:true 建进程组,超时对 -pid 发 SIGKILL(不打 taskkill)", async () => {
    await withPlatform("linux", async () => {
      const killSpy = vi
        .spyOn(process, "kill")
        .mockImplementation((() => true) as unknown as typeof process.kill);
      const holder: { fake: FakeChild | null } = { fake: null };
      spawnHarness.impl = () => {
        holder.fake = createFakeChild(900_004);
        return holder.fake.child;
      };

      const promise = defaultStageCommandRunner("demucs", [], 20);

      expect(spawnHarness.calls[0]?.options.windowsHide).toBe(true);
      expect(spawnHarness.calls[0]?.options.detached).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(killSpy).toHaveBeenCalledWith(-900_004, "SIGKILL");
      // POSIX 树杀路径不 spawn taskkill
      expect(spawnHarness.calls).toHaveLength(1);

      holder.fake?.emitClose(null, "SIGKILL");
      await expect(promise).rejects.toThrow(/killed\(timeout=20ms\)/u);
      expect(activeChildPids.has(900_004)).toBe(false);
    });
  });
});

describe("runStageCommand 重新导出(vocal-remove-handler 兼容)", () => {
  it("从共享 process-runner 抽出后仍可自 vocal-remove-handler 导入且行为一致", async () => {
    const result = await runStageCommand(
      process.execPath,
      ["-e", "process.stdout.write('re-export-ok')"],
      10_000
    );

    expect(result).toEqual({ stdout: "re-export-ok", stderr: "" });
  });
});

describe("YtDlpProvider 默认 run(接入共享进程 runner)", () => {
  it("search 走 spawn 版 runner:解析 stdout JSON,pid 登记随 close 清理,windowsHide 生效", async () => {
    const holder: { fake: FakeChild | null } = { fake: null };
    spawnHarness.impl = () => {
      holder.fake = createFakeChild(910_001);
      return holder.fake.child;
    };

    const provider = new YtDlpProvider({});
    const promise = provider.search({ query: "hello", limit: 3 });

    expect(spawnHarness.calls[0]?.command).toBe("yt-dlp");
    expect(spawnHarness.calls[0]?.options.windowsHide).toBe(true);
    expect(activeChildPids.has(910_001)).toBe(true);

    holder.fake?.emitStdout(
      JSON.stringify({
        entries: [
          { id: "vid-1", title: "Hello MV", duration: 61, url: "https://youtu.be/vid-1" }
        ]
      })
    );
    holder.fake?.emitClose(0, null);

    const candidates = await promise;
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.providerCandidateId).toBe("vid-1");
    expect(candidates[0]?.durationMs).toBe(61_000);
    expect(activeChildPids.has(910_001)).toBe(false);
  });

  it("非零退出码报错保留 exit= 契约,可被 trimFailureMessage 截取", async () => {
    const holder: { fake: FakeChild | null } = { fake: null };
    spawnHarness.impl = () => {
      holder.fake = createFakeChild(910_002);
      return holder.fake.child;
    };

    const provider = new YtDlpProvider({});
    const promise = provider.search({ query: "hello", limit: 3 });
    holder.fake?.emitStderr("ERROR: [youtube] vid-1: Video unavailable");
    holder.fake?.emitClose(2, null);

    const error: Error | null = await promise.then(
      () => null,
      (e: Error) => e
    );
    expect(error?.message).toContain("yt-dlp search failed:");
    expect(error?.message).toMatch(/exit=2/u);
    expect(trimFailureMessage(error?.message ?? "")).toMatch(/exit=2/u);
    expect(activeChildPids.has(910_002)).toBe(false);
  });
});
