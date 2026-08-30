import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { activeChildPids, killProcessTree } from "./process-runner.js";

// ---- 常驻 python sidecar 客户端 -----------------------------------------
// 背景:demucs 与 Qwen3 对齐每首歌现起 python 进程并重新加载数 GB 模型
// (demucs ~分钟级、aligner 首跑更久)。改为常驻 apps/api/python/media_sidecar.py
// 子进程(stdin/stdout JSON-lines 协议),模型进程内缓存,首个请求才加载。
//
// 可靠性契约(绝不让 sidecar 故障阻塞管线):
// - 懒启动:首个请求才 spawn;启动即发 ping 探活;
// - 崩溃自动重启:连续崩溃最多 3 次,超过标记 broken,后续请求立即 reject
//   (SidecarTransportError),调用方 alignViaSidecar/runDemucsViaSidecar 收到
//   false 后走原 spawn 单次脚本路径;
// - 单请求超时:超时树杀 sidecar(模型可能卡死),按崩溃计一次;
// - shutdown():树杀(pid 复用 process-runner 的 activeChildPids 登记机制),
//   worker 优雅退出时调用;
// - 逻辑失败与传输失败严格区分:sidecar 回 {"ok":false} 是正常业务失败,
//   resolve 交给 handler 按旧路径语义处理;只有进程崩溃/超时/broken 才 reject。

export const DEFAULT_SIDECAR_ALIGN_TIMEOUT_MS = 20 * 60 * 1000;
export const DEFAULT_SIDECAR_DEMUCS_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_SIDECAR_PING_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CONSECUTIVE_CRASHES = 3;

export interface SidecarAlignArgs {
  audio: string;
  lyrics: string;
  out: string;
  language: string;
  model: string;
  device: string;
  dtype: string;
}

export interface SidecarDemucsArgs {
  audio: string;
  outDir: string;
  model: string;
  device: string;
  /** CLI 回退命令(demucs python API 不可用时 sidecar 内部 subprocess 使用) */
  fallbackBin?: string;
  binArgs?: string;
}

export interface SidecarResponse {
  id: number | null;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

// 传输层错误(进程崩溃/超时/broken/spawn 失败):调用方据此回退旧路径。
// 业务失败(ok:false)不是传输错误,通过 resolve 的 response 传递。
export class SidecarTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SidecarTransportError";
  }
}

// ---- 协议编解码(纯函数,便于单测) --------------------------------------

export function encodeSidecarRequest(id: number, cmd: string, args: object): string {
  return `${JSON.stringify({ id, cmd, args })}\n`;
}

export function parseSidecarLine(line: string): SidecarResponse | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.ok !== "boolean") {
    return null;
  }
  return {
    id: typeof record.id === "number" ? record.id : null,
    ok: record.ok,
    ...(record.result !== undefined ? { result: record.result as Record<string, unknown> } : {}),
    ...(typeof record.error === "string" ? { error: record.error } : {})
  };
}

// ---- spawn 工厂(可注入,测试用假 sidecar 进程) --------------------------

export type SidecarSpawn = (command: string, args: readonly string[]) => ChildProcess;

const defaultSpawn: SidecarSpawn = (command, args) =>
  spawn(command, [...args], {
    windowsHide: true,
    ...(process.platform === "win32" ? {} : { detached: true }),
    stdio: ["pipe", "pipe", "pipe"]
  });

export type SidecarTreeKill = (pid: number) => Promise<void>;

export interface PythonSidecarOptions {
  /** python 解释器(qwen_asr/demucs 已安装) */
  bin: string;
  /** media_sidecar.py 绝对路径 */
  scriptPath: string;
  /** demucs CLI 回退命令(demucs python API 不可用时透传给 sidecar) */
  demucsBin?: string;
  demucsArgs?: string;
  alignTimeoutMs?: number;
  demucsTimeoutMs?: number;
  maxConsecutiveCrashes?: number;
  spawnImpl?: SidecarSpawn;
  killImpl?: SidecarTreeKill;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

interface PendingRequest {
  resolve: (response: SidecarResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class PythonSidecar {
  readonly bin: string;
  readonly scriptPath: string;
  readonly demucsBin: string;
  readonly demucsArgs: string;
  readonly alignTimeoutMs: number;
  readonly demucsTimeoutMs: number;
  private readonly maxConsecutiveCrashes: number;
  private readonly spawnImpl: SidecarSpawn;
  private readonly killImpl: SidecarTreeKill;
  private readonly log: (message: string, meta?: Record<string, unknown>) => void;

  private child: ChildProcess | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private consecutiveCrashes = 0;
  private broken = false;
  private shutdownRequested = false;

  constructor(options: PythonSidecarOptions) {
    this.bin = options.bin;
    this.scriptPath = options.scriptPath;
    this.demucsBin = options.demucsBin ?? "";
    this.demucsArgs = options.demucsArgs ?? "";
    this.alignTimeoutMs = options.alignTimeoutMs ?? DEFAULT_SIDECAR_ALIGN_TIMEOUT_MS;
    this.demucsTimeoutMs = options.demucsTimeoutMs ?? DEFAULT_SIDECAR_DEMUCS_TIMEOUT_MS;
    this.maxConsecutiveCrashes = options.maxConsecutiveCrashes ?? DEFAULT_MAX_CONSECUTIVE_CRASHES;
    this.spawnImpl = options.spawnImpl ?? defaultSpawn;
    this.killImpl = options.killImpl ?? ((pid) => killProcessTree(pid));
    this.log = options.log ?? (() => undefined);
  }

  isBroken(): boolean {
    return this.broken;
  }

  isRunning(): boolean {
    return this.child !== null;
  }

  /** 对齐请求:resolve = 收到 sidecar 应答(ok/false 均为业务结果);
   * reject(SidecarTransportError)= 传输层故障,调用方应回退旧路径。 */
  async align(args: SidecarAlignArgs, timeoutMs: number = this.alignTimeoutMs): Promise<SidecarResponse> {
    return this.request("align", args, timeoutMs);
  }

  /** 人声分离请求,语义同 align。 */
  async demucs(
    args: SidecarDemucsArgs,
    timeoutMs: number = this.demucsTimeoutMs
  ): Promise<SidecarResponse> {
    const payload: Record<string, unknown> = { ...args };
    if (!args.fallbackBin && this.demucsBin) {
      payload.fallbackBin = this.demucsBin;
    }
    if (args.binArgs === undefined && this.demucsArgs) {
      payload.binArgs = this.demucsArgs;
    }
    return this.request("demucs", payload, timeoutMs);
  }

  async ping(timeoutMs: number = DEFAULT_SIDECAR_PING_TIMEOUT_MS): Promise<SidecarResponse> {
    return this.request("ping", {}, timeoutMs);
  }

  private async request(cmd: string, args: object, timeoutMs: number): Promise<SidecarResponse> {
    if (this.broken) {
      throw new SidecarTransportError("media sidecar is broken (repeated crashes); use fallback path");
    }
    if (!this.child) {
      this.start();
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const request = encodeSidecarRequest(id, cmd, args);
    return new Promise<SidecarResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(id);
        this.pending.delete(id);
        // 超时:模型可能卡死,树杀让进程状态收敛;按崩溃计一次
        // (terminateTree 置 shutdownRequested,exit 事件不会再重复计数)
        this.noteCrash(`request id=${id} cmd=${cmd} timed out after ${timeoutMs}ms`);
        const rejectRequest = entry ? entry.reject : reject;
        rejectRequest(new SidecarTransportError(`media sidecar timeout: cmd=${cmd}`));
        void this.terminateTree("request timeout");
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child?.stdin?.write(request, (error) => {
        if (error) {
          const entry = this.pending.get(id);
          this.pending.delete(id);
          clearTimeout(timer);
          const rejectRequest = entry ? entry.reject : reject;
          rejectRequest(
            new SidecarTransportError(`media sidecar stdin write failed: ${error.message}`)
          );
        }
      });
    });
  }

  // 启动子进程并发 ping 探活。ping 失败按崩溃处理并向上抛传输错误。
  private start(): void {
    if (this.child) {
      return;
    }
    this.shutdownRequested = false;
    let child: ChildProcess;
    try {
      child = this.spawnImpl(this.bin, [this.scriptPath]);
    } catch (error) {
      throw new SidecarTransportError(
        `media sidecar spawn failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    this.child = child;
    if (child.pid !== undefined) {
      activeChildPids.add(child.pid);
    }
    this.log("media sidecar started", { pid: child.pid ?? null, bin: this.bin });

    const rejectAll = (error: Error): void => {
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.reject(error);
      }
    };

    const stdout = child.stdout;
    if (stdout) {
      const readline = createInterface({ input: stdout });
      readline.on("line", (line: string) => {
        const response = parseSidecarLine(line);
        if (!response) {
          this.log("media sidecar sent unparsable line", { line: line.slice(0, 200) });
          return;
        }
        if (response.id === null) {
          this.log("media sidecar sent response without id", { response });
          return;
        }
        const entry = this.pending.get(response.id);
        if (!entry) {
          // 超时后迟到/重复的应答:直接丢弃
          return;
        }
        this.pending.delete(response.id);
        clearTimeout(entry.timer);
        this.consecutiveCrashes = 0;
        entry.resolve(response);
      });
    }

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        this.log("media sidecar stderr", { tail: text.split(/\r?\n/u).slice(-4).join(" / ").slice(0, 400) });
      }
    });

    child.once("error", (error: Error) => {
      this.handleChildGone(child, true, () =>
        rejectAll(new SidecarTransportError(`media sidecar process error: ${error.message}`))
      );
    });
    child.once("exit", (code, signal) => {
      // 空闲退出(code=0 且无在途请求)是 python 侧 30min 无消息自杀的正常行为,
      // 不算崩溃;其余非主动关闭(有在途请求 / 非零退出)计一次连续崩溃。
      this.handleChildGone(
        child,
        !this.shutdownRequested && (this.pending.size > 0 || (code !== 0 && code !== null)),
        () => {
          rejectAll(
            new SidecarTransportError(
              `media sidecar exited unexpectedly (code=${code}, signal=${signal})`
            )
          );
        }
      );
    });
  }

  // 进程消失(崩溃/被杀)的统一处理:注销 pid、清子进程引用、按需计一次
  // 连续崩溃;超过上限置 broken。同一子进程的 error+exit 双触发只计一次。
  private handleChildGone(child: ChildProcess, countCrash: boolean, notify: () => void): void {
    if (this.child !== child) {
      // 已被前一个事件处理过(或已被 terminateTree 接管),只通知不重复计数
      notify();
      return;
    }
    this.child = null;
    if (child.pid !== undefined) {
      activeChildPids.delete(child.pid);
    }
    if (child.stdout) {
      // 推进 readline 流,释放挂着的行缓冲
      child.stdout.push(null);
    }
    if (countCrash) {
      this.noteCrash("media sidecar process gone");
    }
    notify();
  }

  private noteCrash(reason: string): void {
    this.consecutiveCrashes += 1;
    this.log("media sidecar crash counted", {
      reason,
      consecutiveCrashes: this.consecutiveCrashes,
      max: this.maxConsecutiveCrashes
    });
    if (this.consecutiveCrashes >= this.maxConsecutiveCrashes) {
      this.broken = true;
      this.log("media sidecar marked broken; all future requests use fallback path");
    }
  }

  private async terminateTree(reason: string): Promise<void> {
    const child = this.child;
    this.shutdownRequested = true;
    this.child = null;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new SidecarTransportError(`media sidecar terminated (${reason})`));
    }
    this.pending.clear();
    if (!child) {
      return;
    }
    if (child.pid !== undefined) {
      activeChildPids.delete(child.pid);
      await this.killImpl(child.pid).catch(() => undefined);
    }
    child.kill();
  }

  /** 树杀 sidecar 并重置状态(下一次请求会重新懒启动,broken 标记一并清除)。 */
  async shutdown(): Promise<void> {
    if (!this.child) {
      this.broken = false;
      this.consecutiveCrashes = 0;
      return;
    }
    await this.terminateTree("shutdown");
    this.broken = false;
    this.consecutiveCrashes = 0;
    this.log("media sidecar shut down");
  }
}

// ---- 全局单例 ------------------------------------------------------------

export interface MediaSidecarBootstrap {
  /** python 解释器;空 = 无法确定 sidecar 用的 python,视为未启用 */
  bin: string;
  /** media_sidecar.py 绝对路径 */
  scriptPath: string;
  demucsBin?: string;
  demucsArgs?: string;
}

let globalSidecar: PythonSidecar | null = null;
let globalSidecarBootstrap: MediaSidecarBootstrap | null = null;

/** 获取(并按需创建)进程级唯一的 media sidecar。enabled=false 或无法定位
 * python 解释器时返回 null,调用方全部走旧 spawn 路径。 */
export function getMediaSidecar(
  bootstrap: MediaSidecarBootstrap | null
): PythonSidecar | null {
  if (!bootstrap || !bootstrap.bin || !bootstrap.scriptPath) {
    return null;
  }
  if (!globalSidecar || globalSidecarBootstrap !== bootstrap) {
    if (globalSidecar) {
      void globalSidecar.shutdown();
    }
    globalSidecarBootstrap = bootstrap;
    globalSidecar = new PythonSidecar({
      bin: bootstrap.bin,
      scriptPath: bootstrap.scriptPath,
      ...(bootstrap.demucsBin ? { demucsBin: bootstrap.demucsBin } : {}),
      ...(bootstrap.demucsArgs ? { demucsArgs: bootstrap.demucsArgs } : {}),
      log: (message, meta) => {
        console.log(`[media-sidecar] ${message}${meta ? ` ${JSON.stringify(meta)}` : ""}`);
      }
    });
  }
  return globalSidecar;
}

/** worker 优雅退出时调用:树杀常驻 sidecar(未启动则 no-op)。 */
export async function shutdownMediaSidecar(): Promise<void> {
  const sidecar = globalSidecar;
  globalSidecar = null;
  globalSidecarBootstrap = null;
  if (sidecar) {
    await sidecar.shutdown();
  }
}
