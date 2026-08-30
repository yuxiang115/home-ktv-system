import { pathToFileURL } from "node:url";
import path from "node:path";
import { Pool } from "pg";
import type { SupplementTaskStage } from "@home-ktv/domain";
import { loadConfig } from "../config.js";
import { PgOnlineSupplementTaskRepository } from "../modules/online-supplement/supplement-task-repository.js";
import {
  SupplementOrchestrator,
  WORKFLOW_STAGES,
  isBatchStage,
  isTerminalStage,
  type StageHandler
} from "../modules/online-supplement/supplement-orchestrator.js";
import { notifySupplementProgress } from "../modules/online-supplement/supplement-progress-channel.js";
import { YtDlpProvider } from "../modules/online-supplement/providers/yt-dlp-provider.js";
import {
  buildSupplementHandlers,
  type SupplementLlmConfig
} from "../modules/online-supplement/supplement-handlers.js";
import { getMediaSidecar, shutdownMediaSidecar, type PythonSidecar } from "../modules/online-supplement/python-sidecar.js";
import {
  activeChildPids,
  killProcessTree
} from "../modules/online-supplement/handlers/vocal-remove-handler.js";
import type { MediaPathMapping } from "../modules/assets/media-path-mapping.js";
import type { ApiConfig } from "../config.js";

const ALL_STAGES: readonly SupplementTaskStage[] = Array.from(
  new Set<SupplementTaskStage>(
    Object.values(WORKFLOW_STAGES).flatMap((stages) => [...stages])
  )
);

const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_LEASE_DURATION_MS = 300_000;

interface WorkerRuntimeOptions {
  pollIntervalMs: number;
  leaseDurationMs: number;
  workerId: string;
  dryRun: boolean;
  ytDlpBin: string;
}

function readString(value: string | undefined): string {
  return value?.trim() ?? "";
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readBoolean(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function resolveWorkerRuntimeOptions(env: NodeJS.ProcessEnv): WorkerRuntimeOptions {
  return {
    pollIntervalMs: readPositiveInteger(env.SUPPLEMENT_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS),
    leaseDurationMs: readPositiveInteger(env.SUPPLEMENT_LEASE_DURATION_MS, DEFAULT_LEASE_DURATION_MS),
    workerId: readString(env.SUPPLEMENT_WORKER_ID) || `supplement-worker-${process.pid}`,
    dryRun: readBoolean(env.SUPPLEMENT_DRY_RUN),
    ytDlpBin: readString(env.YT_DLP_BIN) || "yt-dlp"
  };
}

function resolveLlmConfig(env: NodeJS.ProcessEnv): SupplementLlmConfig | null {
  const baseUrl = readString(env.KTV_LLM_BASE_URL) || readString(env.LLM_API_BASE_URL);
  const apiKey = readString(env.KTV_LLM_API_KEY) || readString(env.LLM_API_KEY);
  const model = readString(env.KTV_LLM_MODEL) || readString(env.LLM_MODEL) || "gpt-5.5";
  if (!baseUrl || !apiKey) {
    return null;
  }
  return { baseUrl, apiKey, model };
}

function dryRunStageHandler(stage: SupplementTaskStage): StageHandler {
  return {
    stage,
    async execute({ task, reportProgress }) {
      await reportProgress(50, `dry-run ${stage}`);
      if (isTerminalStage(task.workflowId, stage)) {
        return {
          status: "failed",
          failureReason: "dry-run: real pipeline not wired (skeleton)"
        };
      }
      return { status: "completed", message: `dry-run ${stage} ok` };
    }
  };
}

interface HandlerDeps {
  pool: Pool;
  workDir: string;
  provider: YtDlpProvider;
  llm: SupplementLlmConfig | null;
  pathMappings?: readonly MediaPathMapping[];
  lrclibBaseUrl: string;
  demucsBin: string;
  demucsArgs?: string;
  demucsDevice: string;
  demucsModel: string;
  ffmpegBin?: string;
  aligner: {
    bin: string;
    scriptPath: string;
    model: string;
    device: string;
    dtype: string;
  };
  sidecar?: PythonSidecar | null;
}

function buildStageHandlers(runtime: WorkerRuntimeOptions, deps: HandlerDeps): Map<SupplementTaskStage, StageHandler> {
  if (runtime.dryRun) {
    const handlers = new Map<SupplementTaskStage, StageHandler>();
    for (const stage of ALL_STAGES) {
      handlers.set(stage, dryRunStageHandler(stage));
    }
    return handlers;
  }
  // When no LLM is configured the rename handler falls back to a simple title-based
  // name, so the pipeline still runs end-to-end (lower quality naming, but functional).
  const llm = deps.llm ?? { baseUrl: "", apiKey: "", model: "" };
  return buildSupplementHandlers({
    provider: deps.provider,
    db: deps.pool,
    workDir: deps.workDir,
    llm,
    ...(deps.pathMappings ? { pathMappings: deps.pathMappings } : {}),
    lrclibBaseUrl: deps.lrclibBaseUrl,
    demucsBin: deps.demucsBin,
    ...(deps.demucsArgs ? { demucsArgs: deps.demucsArgs } : {}),
    demucsDevice: deps.demucsDevice,
    demucsModel: deps.demucsModel,
    ...(deps.ffmpegBin ? { ffmpegBin: deps.ffmpegBin } : {}),
    aligner: deps.aligner,
    ...(deps.sidecar ? { sidecar: deps.sidecar } : {})
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// sidecar 需要一个真实 python 解释器:优先 ALIGNER_BIN(qwen-asr 那个 python);
// 未配置 aligner 时,若 DEMUCS_BIN 本身指向 python(如 python.exe -m demucs 的
// 用法)也可用;两者都不是 python 则 sidecar 无法启动,保持旧路径。
function looksLikePythonBin(bin: string): boolean {
  const name = path.basename(bin).toLowerCase();
  return /^python(\d+(\.\d+)?)?(w)?(\.exe)?$/u.test(name);
}

function resolveMediaSidecar(config: ApiConfig): PythonSidecar | null {
  if (!config.mediaSidecarEnabled) {
    return null;
  }
  const bin =
    config.alignerBin || (looksLikePythonBin(config.demucsBin) ? config.demucsBin : "");
  if (!bin) {
    console.log(
      "[supplement-worker] MEDIA_SIDECAR_ENABLED=true but no python bin resolvable " +
        "(set ALIGNER_BIN); sidecar disabled, using one-shot script paths"
    );
    return null;
  }
  // sidecar 脚本与 ALIGNER_SCRIPT 同目录(默认 apps/api/python/media_sidecar.py)
  const scriptPath = path.join(
    path.dirname(path.resolve(process.cwd(), config.alignerScript)),
    "media_sidecar.py"
  );
  return getMediaSidecar({
    bin,
    scriptPath,
    ...(config.demucsBin ? { demucsBin: config.demucsBin } : {}),
    ...(config.demucsArgs ? { demucsArgs: config.demucsArgs } : {})
  });
}

interface StopSignal {
  stopped: boolean;
}

// worker 正在执行的 poll 轮次 promise:优雅退出时树杀子进程后等待它结束
// (带上限),保证阶段失败原因落库后再退出。
interface InFlightRound {
  current: Promise<unknown> | null;
}

// 优雅退出时等待在跑阶段收尾的上限:树杀后阶段会快速失败返回,5s 只兜异常卡点。
const GRACEFUL_STAGE_DRAIN_MS = 5000;

// 安装 SIGINT/SIGTERM 处理:首个信号进入优雅退出(树杀全部活跃子进程 → 等
// 在跑的轮次收尾);再次收到信号时不再等待,直接强制退出,避免卡死在不可杀的点。
function installShutdownHandlers(stop: StopSignal, inFlight: InFlightRound): void {
  const handler = (): void => {
    if (stop.stopped) {
      console.log("[supplement-worker] repeated shutdown signal, forcing exit");
      process.exit(1);
    }
    stop.stopped = true;
    // 先关常驻 sidecar:其 pid 也在 activeChildPids 里,但显式 shutdown 会立即
    // reject 在途请求,让依赖它的阶段快速返回后再进入统一树杀流程
    void shutdownMediaSidecar();
    void drainActiveChildren(inFlight);
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
}

// 优雅退出主体:1) 对 activeChildPids 里每个 pid 做树杀(demucs/ffmpeg/对齐
// python 及其全部孙进程);2) 等在跑的轮次 promise 结束(5s 上限),超时说明有
// 不可收敛的卡点,强制退出,任务状态交给 lease 过期回收自愈。
async function drainActiveChildren(inFlight: InFlightRound): Promise<void> {
  const pids = Array.from(activeChildPids);
  if (pids.length > 0) {
    console.log(
      `[supplement-worker] shutdown: tree-killing ${pids.length} active child process tree(s): ${pids.join(", ")}`
    );
  }
  await Promise.allSettled(pids.map((pid) => killProcessTree(pid)));

  const running = inFlight.current;
  if (!running) {
    return;
  }
  const drained = await Promise.race([
    Promise.resolve(running).then(
      () => true,
      () => true
    ),
    sleep(GRACEFUL_STAGE_DRAIN_MS).then(() => false)
  ]);
  if (!drained) {
    console.log(
      `[supplement-worker] in-flight stage still running after ${GRACEFUL_STAGE_DRAIN_MS}ms, forcing exit ` +
        "(task state recovers via lease expiry)"
    );
    process.exit(1);
  }
}

export interface RunSupplementWorkerOptions {
  env?: NodeJS.ProcessEnv;
  pool?: Pool;
}

export async function runSupplementWorker(options: RunSupplementWorkerOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const config = loadConfig(env);
  if (!config.onlineSupplementEnabled) {
    console.log("[supplement-worker] ONLINE_SUPPLEMENT_ENABLED=false, nothing to do");
    return;
  }
  if (!config.databaseUrl) {
    throw new Error("[supplement-worker] DATABASE_URL is required");
  }
  if (!config.supplementImportRoot) {
    throw new Error("[supplement-worker] SUPPLEMENT_IMPORT_ROOT is required (NAS library root for produced MVs)");
  }

  const runtime = resolveWorkerRuntimeOptions(env);
  const ownsPool = !options.pool;
  const pool = options.pool ?? new Pool({ connectionString: config.databaseUrl });
  const repo = new PgOnlineSupplementTaskRepository(pool);
  const provider = new YtDlpProvider({
    bin: config.ytDlpBin,
    binArgs: config.ytDlpArgs,
    playerClient: config.youtubePlayerClient,
    cookie: config.youtubeCookie,
    cookiesFromBrowser: config.youtubeCookiesFromBrowser,
    log: (message, meta) => {
      console.log(`[supplement-worker] ${message}${meta ? ` ${JSON.stringify(meta)}` : ""}`);
    }
  });
  const llm = resolveLlmConfig(env);
  const sidecar = resolveMediaSidecar(config);
  const handlers = buildStageHandlers(runtime, {
    pool,
    workDir: config.supplementImportRoot,
    provider,
    llm,
    pathMappings: config.mediaPathMappings,
    lrclibBaseUrl: config.lyricsLrclibBaseUrl,
    demucsBin: config.demucsBin,
    ...(config.demucsArgs ? { demucsArgs: config.demucsArgs } : {}),
    demucsDevice: config.demucsDevice,
    demucsModel: config.demucsModel,
    ...(config.ffmpegBin ? { ffmpegBin: config.ffmpegBin } : {}),
    aligner: {
      bin: config.alignerBin,
      scriptPath: path.resolve(process.cwd(), config.alignerScript),
      model: config.alignerModel,
      device: config.alignerDevice,
      dtype: config.alignerDtype
    },
    ...(sidecar ? { sidecar } : {})
  });
  const orchestrator = new SupplementOrchestrator({
    repo,
    handlers,
    workDir: config.supplementImportRoot,
    workerId: runtime.workerId,
    leaseDurationMs: runtime.leaseDurationMs,
    log: (message, meta) => {
      const ts = new Date().toISOString();
      console.log(`[supplement-worker ${ts}] ${message}${meta ? ` ${JSON.stringify(meta)}` : ""}`);
    }
  });

  console.log(
    `[supplement-worker] started (workerId=${runtime.workerId}, dryRun=${runtime.dryRun}, ` +
      `handlers=[${Array.from(handlers.keys()).join(",")}], ` +
      `aligner=${config.alignerBin ? `${config.alignerModel}@${config.alignerDevice}` : "disabled"}, ` +
      `demucs=${config.demucsBin || "demucs"}@${config.demucsDevice}, ` +
      `sidecar=${sidecar ? "enabled (resident python, lazy start)" : "disabled"}, ` +
      `poll=${runtime.pollIntervalMs}ms, lease=${runtime.leaseDurationMs}ms)`
  );

  // 孤儿自清:子进程生命周期由父进程保证(runner 在 spawn 时登记 pid、exit 时
  // 注销,worker 退出时整棵树击杀),子进程随父死,无需跨重启持久登记到文件/DB,
  // 因此启动时 activeChildPids 必然为空——没有需要清理的历史孤儿。
  console.log(
    `[supplement-worker] startup orphan check: activeChildPids=${activeChildPids.size} ` +
    "(child processes die with this worker by design; no persistent registry to clean)"
  );

  const stop: StopSignal = { stopped: false };
  const inFlight: InFlightRound = { current: null };
  installShutdownHandlers(stop, inFlight);
  try {
    await runPollLoop({
      orchestrator,
      repo,
      pool,
      batchSize: config.supplementBatchSize,
      pollIntervalMs: runtime.pollIntervalMs,
      stop,
      inFlight
    });
  } finally {
    if (ownsPool) {
      await pool.end();
    }
    console.log("[supplement-worker] stopped");
  }
}

interface PollLoopInput {
  orchestrator: SupplementOrchestrator;
  repo: PgOnlineSupplementTaskRepository;
  pool: Pool;
  batchSize: number;
  pollIntervalMs: number;
  stop: StopSignal;
  inFlight: InFlightRound;
}

async function runPollLoop(input: PollLoopInput): Promise<void> {
  while (!input.stop.stopped) {
    // 把当前轮次的 promise 挂到 inFlight,优雅退出时树杀后能等到它收尾
    input.inFlight.current = runPollRound(input);
    await input.inFlight.current;
    input.inFlight.current = null;
    if (input.stop.stopped) {
      // 信号已到达:不再多睡一个 poll 间隔,尽快退出
      break;
    }
    await sleep(input.pollIntervalMs);
  }
}

async function runPollRound(input: PollLoopInput): Promise<void> {
  try {
    const reclaimed = await input.repo.reclaimStaleLeases(new Date());
    if (reclaimed > 0) {
      console.log(`[supplement-worker] reclaimed ${reclaimed} stale lease(s)`);
    }

    for (const stage of ALL_STAGES) {
      if (!input.orchestrator.hasHandlerFor(stage)) {
        continue;
      }
      const summary = isBatchStage(stage)
        ? await input.orchestrator.processBatchStage(stage, input.batchSize)
        : await input.orchestrator.processSerialStage(stage);
      // Notify right after each stage call instead of waiting for the whole
      // round: a single slow stage (e.g. a ~15min demucs run) must not freeze
      // progress for every other task in the room.
      const stageRooms = new Set(summary.processedTasks.map((task) => task.roomId));
      for (const roomId of stageRooms) {
        try {
          await notifySupplementProgress(input.pool, roomId);
        } catch (error) {
          // A failed notify must not abort the remaining stages of this round.
          console.error(`[supplement-worker] progress notify failed for room ${roomId}:`, error);
        }
      }
    }
  } catch (error) {
    console.error("[supplement-worker] poll iteration failed:", error);
  }
}

const entrypointUrl = pathToFileURL(process.argv[1] ?? "").href;
if (import.meta.url === entrypointUrl) {
  runSupplementWorker().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
