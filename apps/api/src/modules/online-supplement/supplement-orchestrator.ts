import type {
  OnlineSupplementTask,
  SupplementTaskStage,
  SupplementWorkflowId
} from "@home-ktv/domain";
import type { OnlineSupplementTaskRepository } from "./supplement-task-repository.js";

export const WORKFLOW_STAGES: Record<SupplementWorkflowId, readonly SupplementTaskStage[]> = {
  "youtube-basic": ["download", "rename", "lyrics", "index"],
  "youtube-enhanced": ["download", "rename", "lyrics", "vocal_remove", "mix", "index"]
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

    let result: StageExecuteResult;
    try {
      this.log(`stage start`, { taskId: task.id, stage: task.stage, title: task.title, workflow: task.workflowId });
      result = await handler.execute({
        task,
        workerId: this.workerId,
        workDir: this.workDir,
        renewLease,
        reportProgress
      });
    } catch (error) {
      result = {
        status: "failed",
        failureReason: error instanceof Error ? error.message : String(error)
      };
    }

    const now = this.now();
    if (result.status === "failed") {
      this.log(`stage FAILED`, {
        taskId: task.id,
        stage: task.stage,
        title: task.title,
        reason: result.failureReason ?? "handler reported failure"
      });
      await this.repo.markFailed({
        taskId: task.id,
        failureStage: task.stage,
        reason: result.failureReason ?? "handler reported failure",
        now
      });
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
      await this.repo.markReady({
        taskId: task.id,
        readySongId: result.readySongId ?? "",
        finalFilePath: result.finalFilePath ?? task.finalFilePath ?? "",
        lyricFile: result.lyricFile ?? task.lyricFile,
        now
      });
      return;
    }

    this.log(`stage done`, {
      taskId: task.id,
      stage: task.stage,
      nextStage,
      message: result.message ?? ""
    });
    await this.repo.completeStage({
      taskId: task.id,
      nextStage,
      ...(result.message !== undefined ? { stageMessage: result.message } : {}),
      ...(result.llmRenamedTitle !== undefined ? { llmRenamedTitle: result.llmRenamedTitle } : {}),
      ...(result.finalFilePath !== undefined ? { finalFilePath: result.finalFilePath } : {}),
      ...(result.lyricFile !== undefined ? { lyricFile: result.lyricFile } : {}),
      now
    });
  }
}
