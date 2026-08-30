import { rm } from "node:fs/promises";
import path from "node:path";
import type {
  OnlineSupplementTask,
  SupplementTaskStage,
  SupplementWorkflowId
} from "@home-ktv/domain";
import type { OnlineSupplementTaskRepository } from "./supplement-task-repository.js";

const DOWNLOADS_SUBDIR = "_downloads";
const STEMS_SUBDIR = "_stems";
const MIXED_SUBDIR = "_mixed";
const LYRICS_SUBDIR = "_lyrics";

/**
 * best-effort 清理任务中间产物(下载原片/分離人声产物/混音产物/歌词)。
 * 每项独立吞错:清理失败只意味着磁盘残留,不应影响任务状态流转。
 */
export async function cleanupSupplementIntermediates(workDir: string, taskId: string): Promise<void> {
  await Promise.all([
    rm(path.join(workDir, DOWNLOADS_SUBDIR, `${taskId}.mkv`), { force: true }).catch(() => undefined),
    rm(path.join(workDir, STEMS_SUBDIR, taskId), { recursive: true, force: true }).catch(() => undefined),
    rm(path.join(workDir, MIXED_SUBDIR, `${taskId}.mkv`), { force: true }).catch(() => undefined),
    rm(path.join(workDir, LYRICS_SUBDIR, `${taskId}.lrc`), { force: true }).catch(() => undefined),
    rm(path.join(workDir, LYRICS_SUBDIR, `${taskId}.karaoke.json`), { force: true }).catch(() => undefined)
  ]);
}

export const WORKFLOW_STAGES: Record<SupplementWorkflowId, readonly SupplementTaskStage[]> = {
  "youtube-basic": ["download", "rename", "lyrics", "index"],
  "youtube-enhanced": ["download", "rename", "lyrics", "vocal_remove", "align", "mix", "index"]
};

export const BATCH_STAGES: ReadonlySet<SupplementTaskStage> = new Set<SupplementTaskStage>([
  "rename",
  "vocal_remove"
]);

export function nextStageFor(
  workflow: SupplementWorkflowId,
  current: SupplementTaskStage
): SupplementTaskStage | null {
  const stages = WORKFLOW_STAGES[workflow];
  const index = stages.indexOf(current);
  if (index < 0 || index >= stages.length - 1) {
    return null;
  }
  return stages[index + 1] ?? null;
}

export function isBatchStage(stage: SupplementTaskStage): boolean {
  return BATCH_STAGES.has(stage);
}

export function isTerminalStage(workflow: SupplementWorkflowId, stage: SupplementTaskStage): boolean {
  return nextStageFor(workflow, stage) === null;
}

export interface StageExecuteInput {
  task: OnlineSupplementTask;
  workerId: string;
  workDir: string;
  renewLease: (leaseUntil: Date) => Promise<void>;
  reportProgress: (percent: number, message: string) => Promise<void>;
  /** 阶段内详细日志(文件操作、重试等),由编排器统一带上 taskId 前缀输出 */
  log: (message: string, meta?: Record<string, unknown>) => void;
}

export interface StageExecuteResult {
  status: "completed" | "failed";
  message?: string;
  failureReason?: string;
  llmRenamedTitle?: string | null;
  finalFilePath?: string | null;
  lyricFile?: string | null;
  readySongId?: string | null;
}

export interface StageHandler {
  readonly stage: SupplementTaskStage;
  execute(input: StageExecuteInput): Promise<StageExecuteResult>;
}

export type SupplementOrchestratorLog = (message: string, meta?: Record<string, unknown>) => void;

export interface SupplementOrchestratorOptions {
  repo: OnlineSupplementTaskRepository;
  handlers: ReadonlyMap<SupplementTaskStage, StageHandler>;
  workDir: string;
  workerId: string;
  leaseDurationMs: number;
  now?: () => Date;
  log?: SupplementOrchestratorLog;
}

export interface StageRunSummary {
  processedTasks: OnlineSupplementTask[];
}

export class SupplementOrchestrator {
  private readonly repo: OnlineSupplementTaskRepository;
  private readonly handlers: ReadonlyMap<SupplementTaskStage, StageHandler>;
  private readonly workDir: string;
  private readonly workerId: string;
  private readonly leaseDurationMs: number;
  private readonly now: () => Date;
  private readonly log: SupplementOrchestratorLog;

  constructor(options: SupplementOrchestratorOptions) {
    this.repo = options.repo;
    this.handlers = options.handlers;
    this.workDir = options.workDir;
    this.workerId = options.workerId;
    this.leaseDurationMs = options.leaseDurationMs;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => undefined);
  }

  hasHandlerFor(stage: SupplementTaskStage): boolean {
    return this.handlers.has(stage);
  }

  async processSerialStage(stage: SupplementTaskStage): Promise<StageRunSummary> {
    const handler = this.handlers.get(stage);
    if (!handler) {
      return { processedTasks: [] };
    }

    const now = this.now();
    const task = await this.repo.claimForStage({
      stage,
      workerId: this.workerId,
      leaseUntil: new Date(now.getTime() + this.leaseDurationMs),
      now
    });
    if (!task) {
      return { processedTasks: [] };
    }

    await this.runHandlerAndAdvance(task, handler);
    return { processedTasks: [task] };
  }

  async processBatchStage(stage: SupplementTaskStage, batchSize: number): Promise<StageRunSummary> {
    const handler = this.handlers.get(stage);
    if (!handler) {
      return { processedTasks: [] };
    }

    const now = this.now();
    const tasks = await this.repo.claimBatchForStage({
      stage,
      workerId: this.workerId,
      leaseUntil: new Date(now.getTime() + this.leaseDurationMs),
      now,
      batchSize
    });
    if (tasks.length === 0) {
      return { processedTasks: [] };
    }

    for (const task of tasks) {
      await this.runHandlerAndAdvance(task, handler);
    }
    return { processedTasks: tasks };
  }

  private async runHandlerAndAdvance(task: OnlineSupplementTask, handler: StageHandler): Promise<void> {
    const renewLease = async (leaseUntil: Date): Promise<void> => {
      await this.repo.renewLease({
        taskId: task.id,
        workerId: this.workerId,
        leaseUntil,
        now: this.now()
      });
    };
    const reportProgress = async (percent: number, message: string): Promise<void> => {
      await this.repo.updateStageProgress({
        taskId: task.id,
        percent,
        message,
        now: this.now()
      });
    };
    const stageLog = (message: string, meta?: Record<string, unknown>): void => {
      this.log(message, { taskId: task.id, stage: task.stage, ...(meta ?? {}) });
    };

    let result: StageExecuteResult;
    try {
      this.log(`stage start`, { taskId: task.id, stage: task.stage, title: task.title, workflow: task.workflowId });
      result = await handler.execute({
        task,
        workerId: this.workerId,
        workDir: this.workDir,
        renewLease,
        reportProgress,
        log: stageLog
      });
    } catch (error) {
      result = {
        status: "failed",
        failureReason: error instanceof Error ? error.message : String(error)
      };
    }

    try {
      await this.persistStageOutcome(task, result, stageLog);
    } catch (error) {
      // 状态写回失败(DB 闪断、约束冲突等)绝不能抛出到 worker 循环,否则任务
      // 永远停在 running,lease 过期后被反复回收重认领。做一次 markFailed 补救;
      // 补救也失败就只留日志,让 lease 过期回收兜底。
      const reason = `stage result persistence failed: ${error instanceof Error ? error.message : String(error)}`;
      stageLog(`stage result persistence failed`, {
        error: error instanceof Error ? error.message : String(error)
      });
      try {
        await this.repo.markFailed({
          taskId: task.id,
          failureStage: task.stage,
          reason,
          now: this.now()
        });
      } catch (rescueError) {
        stageLog(`markFailed rescue failed; awaiting lease expiry reclaim`, {
          error: rescueError instanceof Error ? rescueError.message : String(rescueError)
        });
      }
    }
  }

  private async persistStageOutcome(
    task: OnlineSupplementTask,
    result: StageExecuteResult,
    stageLog: (message: string, meta?: Record<string, unknown>) => void
  ): Promise<void> {
    const now = this.now();
    if (result.status === "failed") {
      this.log(`stage FAILED`, {
        taskId: task.id,
        stage: task.stage,
        title: task.title,
        reason: result.failureReason ?? "handler reported failure"
      });
      // 失败任务的中间产物无人认领;best-effort 清理,失败只留日志。
      // download 阶段失败时没有产物,清理为空操作,无害。
      try {
        await cleanupSupplementIntermediates(this.workDir, task.id);
      } catch (cleanupError) {
        stageLog(`intermediates cleanup after failure failed`, {
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        });
      }
      const failedOutcome = await this.repo.markFailed({
        taskId: task.id,
        workerId: this.workerId,
        failureStage: task.stage,
        reason: result.failureReason ?? "handler reported failure",
        now
      });
      if (failedOutcome === null) {
        stageLog(`fenced out (lease lost to another worker); markFailed skipped`, { taskId: task.id });
      }
      return;
    }

    const nextStage = nextStageFor(task.workflowId, task.stage);
    if (nextStage === null) {
      this.log(`task READY`, {
        taskId: task.id,
        title: task.title,
        renamed: task.llmRenamedTitle,
        readySongId: result.readySongId ?? "",
        finalFilePath: result.finalFilePath ?? task.finalFilePath ?? ""
      });
      const readyOutcome = await this.repo.markReady({
        taskId: task.id,
        workerId: this.workerId,
        readySongId: result.readySongId ?? "",
        finalFilePath: result.finalFilePath ?? task.finalFilePath ?? "",
        lyricFile: result.lyricFile ?? task.lyricFile,
        now
      });
      if (readyOutcome === null) {
        stageLog(`fenced out (lease lost to another worker); markReady skipped`, { taskId: task.id });
      }
      return;
    }

    this.log(`stage done`, {
      taskId: task.id,
      stage: task.stage,
      nextStage,
      message: result.message ?? ""
    });
    const completeOutcome = await this.repo.completeStage({
      taskId: task.id,
      workerId: this.workerId,
      nextStage,
      ...(result.message !== undefined ? { stageMessage: result.message } : {}),
      ...(result.llmRenamedTitle !== undefined ? { llmRenamedTitle: result.llmRenamedTitle } : {}),
      ...(result.finalFilePath !== undefined ? { finalFilePath: result.finalFilePath } : {}),
      ...(result.lyricFile !== undefined ? { lyricFile: result.lyricFile } : {}),
      now
    });
    if (completeOutcome === null) {
      stageLog(`fenced out (lease lost to another worker); completeStage skipped`, { taskId: task.id });
    }
  }
}
