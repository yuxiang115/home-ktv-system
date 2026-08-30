import { spawn, type ChildProcess } from "node:child_process";

// ---- 子进程执行与进程树生命周期管理 -------------------------------------
// 背景:各阶段工具都会再生子进程(yt-dlp 内部拉起 ffmpeg、demucs 的 python 子进程),
// execFile 的 timeout 只杀直接子进程,孙进程全部变孤儿;Windows 上孤儿进程会累积
// 消耗桌面堆,最终导致 0xC0000142。这里统一改为 spawn + 超时/失败时整棵树击杀,
// 把「任务进程树必死」做成机制保证:
// - win32:taskkill /PID <pid> /T /F 递归击杀,child.kill() 兜底;
// - POSIX:detached 起独立进程组,kill(-pid, SIGKILL) 组杀。
//
// 本模块是共享导出:下载阶段的 yt-dlp provider 与 vocal_remove/mix/align 等阶段的
// handler 都经由这里执行外部命令,共用 activeChildPids 登记与树杀语义。

// stdout/stderr 手动收集上限(对应 execFile 时代的 maxBuffer: 20MB):超限即树杀,
// 防止失控输出把 worker 内存吃爆。
const DEFAULT_OUTPUT_LIMIT_BYTES = 20 * 1024 * 1024;
// taskkill 自身卡死时的兜底等待,不让树杀调用挂起优雅退出流程。
const TREE_KILL_GRACE_MS = 10_000;

// 模块级活跃子进程 pid 登记:spawn 时加入、exit 时移除。
// worker 优雅退出(SIGINT/SIGTERM)时据此对每棵子进程树兜底击杀。
// 子进程生命周期由父进程保证(随父死),无需跨重启持久登记到文件/DB。
export const activeChildPids = new Set<number>();

export interface StageCommandOutput {
  stdout: string;
  stderr: string;
}

export type StageCommandRunner = (
  bin: string,
  args: readonly string[],
  timeoutMs: number
) => Promise<StageCommandOutput | void>;

export interface TreeKillCommand {
  command: string;
  args: string[];
}

// 树杀命令拼装(纯函数,便于跨平台单测):
// win32 → taskkill /PID <pid> /T /F(递归杀整棵进程树);
// POSIX → null,调用方改用 process.kill(-pid, "SIGKILL") 杀 detached 进程组。
export function buildTreeKillCommand(pid: number, platform: NodeJS.Platform): TreeKillCommand | null {
  if (platform === "win32") {
    return { command: "taskkill", args: ["/PID", String(pid), "/T", "/F"] };
  }
  return null;
}

// 对 pid 及其全部子孙进程做树杀。win32 走 taskkill(taskkill 不可用时退回直接
// kill 单进程);POSIX 对 detached 进程组发 SIGKILL,组不存在时退回单进程 kill。
export async function killProcessTree(pid: number): Promise<void> {
  const command = buildTreeKillCommand(pid, process.platform);
  if (!command) {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // 进程已死,无事可做
      }
      return;
    }
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    };
    const timer = setTimeout(finish, TREE_KILL_GRACE_MS);
    let killer: ChildProcess;
    try {
      killer = spawn(command.command, command.args, { stdio: "ignore", windowsHide: true });
    } catch {
      finish();
      return;
    }
    killer.once("close", finish);
    killer.once("error", () => {
      // taskkill 本身不可用(极端环境):退回直接 kill 单进程
      try {
        process.kill(pid);
      } catch {
        // 进程已死,无事可做
      }
      finish();
    });
  });
}

interface StageFailureContext {
  bin: string;
  args: readonly string[];
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  overflowedStream: "stdout" | "stderr" | null;
  timeoutMs: number;
  stdout: string;
  stderr: string;
}

// 与 execFile 时代的报错语义对齐:message 以 "Command failed: <cmd>" 开头,并保留
// exit=<code> / killed(timeout=NNNms) 片段——下游 yt-dlp-provider 的
// trimFailureMessage(/exit=\d+|killed\(timeout=\d+ms\)/)与 isEnvironmentSpawnFailure
// (/exit=322122579[04]/,桌面堆故障分类)按这些模式识别,格式不能变。
function buildStageFailureMessage(ctx: StageFailureContext): string {
  const details: string[] = [];
  if (ctx.code !== null) {
    details.push(`exit=${ctx.code}`);
  }
  if (ctx.signal) {
    details.push(`signal=${ctx.signal}`);
  }
  if (ctx.timedOut) {
    details.push(`killed(timeout=${ctx.timeoutMs}ms)`);
  }
  if (ctx.overflowedStream) {
    details.push(`killed(output-limit=${DEFAULT_OUTPUT_LIMIT_BYTES}bytes on ${ctx.overflowedStream})`);
  }
  const tail = tailText(ctx.stderr) ?? tailText(ctx.stdout);
  const head = `Command failed: ${[ctx.bin, ...ctx.args].join(" ")}`;
  const detailText = [details.join(", "), tail].filter(Boolean).join(" | ");
  return detailText ? `${head}: ${detailText}` : head;
}

function tailText(value: string, maxLines = 4, maxChars = 400): string | null {
  const joined = value.trim().split(/\r?\n/u).filter(Boolean).slice(-maxLines).join(" / ");
  return joined ? joined.slice(0, maxChars) : null;
}

// 统一的外部命令执行入口:spawn 起进程(windowsHide / POSIX detached)、登记
// activeChildPids、收集 stdout/stderr(20MB 上限)、超时或超限时整棵进程树击杀。
// 成功 resolve {stdout, stderr};失败 reject,message 格式见 buildStageFailureMessage。
export function runStageCommand(
  bin: string,
  args: readonly string[],
  timeoutMs: number
): Promise<StageCommandOutput> {
  return new Promise<StageCommandOutput>((resolve, reject) => {
    const isWindows = process.platform === "win32";
    // POSIX 用 detached 建独立进程组,kill(-pid) 才能一次杀掉全部子孙;
    // win32 不用 detached(进程反而脱离父进程管辖),树杀交给 taskkill /T。
    // windowsHide:不给每个子进程建控制台,直接减少 Windows 桌面堆消耗。
    const child = spawn(bin, args as string[], {
      windowsHide: true,
      ...(isWindows ? {} : { detached: true }),
      stdio: ["ignore", "pipe", "pipe"]
    });

    const pid = child.pid;
    if (pid !== undefined) {
      activeChildPids.add(pid);
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflowedStream: "stdout" | "stderr" | null = null;
    let timedOut = false;
    let settled = false;

    const collect = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      if (overflowedStream) {
        // 已超限待杀:停止收集,内存不再增长
        return;
      }
      if (stream === "stdout") {
        stdoutBytes += chunk.length;
        stdoutChunks.push(chunk);
        if (stdoutBytes > DEFAULT_OUTPUT_LIMIT_BYTES) {
          overflowedStream = "stdout";
          terminateTree();
        }
      } else {
        stderrBytes += chunk.length;
        stderrChunks.push(chunk);
        if (stderrBytes > DEFAULT_OUTPUT_LIMIT_BYTES) {
          overflowedStream = "stderr";
          terminateTree();
        }
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => collect("stderr", chunk));

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            terminateTree();
          }, timeoutMs)
        : null;

    function terminateTree(): void {
      if (pid === undefined) {
        child.kill();
        return;
      }
      void killProcessTree(pid).finally(() => {
        // 兜底:taskkill/组杀没杀干净时再直接 kill 一次(对已死进程是 no-op)
        child.kill();
      });
    }

    function cleanup(): void {
      if (timer) {
        clearTimeout(timer);
      }
      if (pid !== undefined) {
        activeChildPids.delete(pid);
      }
    }

    child.once("error", (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      // spawn 阶段失败保留原生 message(如 "spawn xxx ENOENT"):
      // 下游 isEnvironmentSpawnFailure 按 "spawn .* ENOENT|EINVAL" 识别环境类故障。
      reject(error);
    });

    child.once("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code === 0 && !timedOut && !overflowedStream) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          buildStageFailureMessage({
            bin,
            args,
            code,
            signal,
            timedOut,
            overflowedStream,
            timeoutMs,
            stdout,
            stderr
          })
        )
      );
    });
  });
}

export const defaultStageCommandRunner: StageCommandRunner = (bin, args, timeoutMs) =>
  runStageCommand(bin, args, timeoutMs);
