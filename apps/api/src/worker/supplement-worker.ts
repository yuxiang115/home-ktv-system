import { pathToFileURL } from "node:url";
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
import type { MediaPathMapping } from "../modules/assets/media-path-mapping.js";

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
    ...(deps.ffmpegBin ? { ffmpegBin: deps.ffmpegBin } : {})
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface StopSignal {
  stopped: boolean;
}

function installShutdownHandlers(): StopSignal {
  const stop: StopSignal = { stopped: false };
  const handler = (): void => {
    stop.stopped = true;
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return stop;
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
    ...(config.ffmpegBin ? { ffmpegBin: config.ffmpegBin } : {})
  });
  const orchestrator = new SupplementOrchestrator({
    repo,
    handlers,
    workDir: config.supplementImportRoot,
    workerId: runtime.workerId,
    leaseDurationMs: runtime.leaseDurationMs,
    log: (message, meta) => {
      console.log(`[supplement-worker] ${message}${meta ? ` ${JSON.stringify(meta)}` : ""}`);
    }
  });

  console.log(
    `[supplement-worker] started (workerId=${runtime.workerId}, dryRun=${runtime.dryRun}, ` +
    `handlers=[${Array.from(handlers.keys()).join(",")}], ` +
    `poll=${runtime.pollIntervalMs}ms, lease=${runtime.leaseDurationMs}ms)`
  );

  const stop = installShutdownHandlers();
  try {
    await runPollLoop({
      orchestrator,
      repo,
      pool,
      batchSize: config.supplementBatchSize,
      pollIntervalMs: runtime.pollIntervalMs,
      stop
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
}

async function runPollLoop(input: PollLoopInput): Promise<void> {
  while (!input.stop.stopped) {
    try {
      const reclaimed = await input.repo.reclaimStaleLeases(new Date());
      if (reclaimed > 0) {
        console.log(`[supplement-worker] reclaimed ${reclaimed} stale lease(s)`);
      }

      const affectedRooms = new Set<string>();
      for (const stage of ALL_STAGES) {
        if (!input.orchestrator.hasHandlerFor(stage)) {
          continue;
        }
        const summary = isBatchStage(stage)
          ? await input.orchestrator.processBatchStage(stage, input.batchSize)
          : await input.orchestrator.processSerialStage(stage);
        for (const task of summary.processedTasks) {
          affectedRooms.add(task.roomId);
        }
      }

      for (const roomId of affectedRooms) {
        await notifySupplementProgress(input.pool, roomId);
      }
    } catch (error) {
      console.error("[supplement-worker] poll iteration failed:", error);
    }

    await sleep(input.pollIntervalMs);
  }
}

const entrypointUrl = pathToFileURL(process.argv[1] ?? "").href;
if (import.meta.url === entrypointUrl) {
  runSupplementWorker().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
