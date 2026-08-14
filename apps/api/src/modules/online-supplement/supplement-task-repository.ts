import type {
  OnlineSupplementTask,
  OnlineSupplementTaskSummary,
  RoomId,
  RoomOnlineSupplementTaskSummary,
  SupplementTaskStage,
  SupplementWorkflowId
} from "@home-ktv/domain";
import type { QueryExecutor } from "../../db/query-executor.js";
import type { OnlineSupplementTaskRow } from "../../db/schema.js";

export interface CreateSupplementTaskInput {
  roomId: RoomId;
  provider: string;
  providerCandidateId: string;
  sourceUrl: string;
  title: string;
  artistName: string;
  durationMs: number | null;
  providerPayload: Record<string, unknown>;
  workflowId: SupplementWorkflowId;
  requestedBy: string | null;
  now: Date;
}

export interface ClaimStageInput {
  stage: SupplementTaskStage;
  workerId: string;
  leaseUntil: Date;
  now: Date;
}

export interface ClaimBatchStageInput extends ClaimStageInput {
  batchSize: number;
}

export interface CompleteStageInput {
  taskId: string;
  nextStage: SupplementTaskStage;
  stageMessage?: string;
  llmRenamedTitle?: string | null;
  finalFilePath?: string | null;
  lyricFile?: string | null;
  now: Date;
}

export interface MarkReadyInput {
  taskId: string;
  readySongId: string;
  finalFilePath: string;
  lyricFile: string | null;
  now: Date;
}

export interface MarkFailedInput {
  taskId: string;
  failureStage: SupplementTaskStage;
  reason: string;
  now: Date;
}

export interface UpdateProgressInput {
  taskId: string;
  percent: number;
  message: string;
  now: Date;
}

export interface RenewLeaseInput {
  taskId: string;
  workerId: string;
  leaseUntil: Date;
  now: Date;
}

export interface OnlineSupplementTaskRepository {
  createTask(input: CreateSupplementTaskInput): Promise<OnlineSupplementTask>;
  claimForStage(input: ClaimStageInput): Promise<OnlineSupplementTask | null>;
  claimBatchForStage(input: ClaimBatchStageInput): Promise<OnlineSupplementTask[]>;
  renewLease(input: RenewLeaseInput): Promise<void>;
  updateStageProgress(input: UpdateProgressInput): Promise<void>;
  completeStage(input: CompleteStageInput): Promise<void>;
  markReady(input: MarkReadyInput): Promise<void>;
  markFailed(input: MarkFailedInput): Promise<void>;
  reclaimStaleLeases(now: Date): Promise<number>;
  listRecentByRoom(roomId: RoomId, limit: number): Promise<OnlineSupplementTaskSummary[]>;
  findById(taskId: string): Promise<OnlineSupplementTask | null>;
}

function mapRowToTask(row: OnlineSupplementTaskRow): OnlineSupplementTask {
  return {
    id: row.id,
    roomId: row.room_id as RoomId,
    provider: row.provider,
    providerCandidateId: row.provider_candidate_id,
    sourceUrl: row.source_url,
    title: row.title,
    artistName: row.artist_name,
    durationMs: row.duration_ms,
    providerPayload: row.provider_payload,
    workflowId: row.workflow_id as SupplementWorkflowId,
    status: row.status as OnlineSupplementTask["status"],
    stage: row.stage as SupplementTaskStage,
    stageStatus: row.stage_status as OnlineSupplementTask["stageStatus"],
    stageProgressPercent: row.stage_progress_percent,
    stageMessage: row.stage_message,
    failureReason: row.failure_reason,
    failureStage: row.failure_stage as SupplementTaskStage | null,
    llmRenamedTitle: row.llm_renamed_title,
    finalFilePath: row.final_file_path,
    lyricFile: row.lyric_file,
    readySongId: row.ready_song_id,
    workerId: row.worker_id,
    workerLeaseUntil: row.worker_lease_until ? row.worker_lease_until.toISOString() : null,
    requestedBy: row.requested_by,
    downloadAt: row.download_at ? row.download_at.toISOString() : null,
    readyAt: row.ready_at ? row.ready_at.toISOString() : null,
    failedAt: row.failed_at ? row.failed_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function mapRowToSummary(row: OnlineSupplementTaskRow): OnlineSupplementTaskSummary {
  return {
    taskId: row.id,
    roomId: row.room_id as RoomId,
    provider: row.provider,
    providerCandidateId: row.provider_candidate_id,
    title: row.llm_renamed_title ?? row.title,
    artistName: row.artist_name,
    durationMs: row.duration_ms,
    workflowId: row.workflow_id as SupplementWorkflowId,
    status: row.status as OnlineSupplementTask["status"],
    stage: row.stage as SupplementTaskStage,
    stageProgressPercent: row.stage_progress_percent,
    stageMessage: row.stage_message,
    failureReason: row.failure_reason,
    llmRenamedTitle: row.llm_renamed_title,
    readySongId: row.ready_song_id,
    lyricFile: row.lyric_file,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

const TASK_COLUMNS = `
  id, room_id, provider, provider_candidate_id, source_url, title, artist_name,
  duration_ms, provider_payload, workflow_id, status, stage, stage_status,
  stage_progress_percent, stage_message, failure_reason, failure_stage,
  llm_renamed_title, final_file_path, lyric_file, ready_song_id,
  worker_id, worker_lease_until, requested_by,
  download_at, ready_at, failed_at, created_at, updated_at`;

export class PgOnlineSupplementTaskRepository implements OnlineSupplementTaskRepository {
  constructor(private readonly db: QueryExecutor) {}

  async createTask(input: CreateSupplementTaskInput): Promise<OnlineSupplementTask> {
    const result = await this.db.query<OnlineSupplementTaskRow>(
      `INSERT INTO online_supplement_tasks (
         room_id, provider, provider_candidate_id, source_url, title, artist_name,
         duration_ms, provider_payload, workflow_id, requested_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
       ON CONFLICT (room_id, provider, provider_candidate_id)
       DO UPDATE SET
         updated_at = now(),
         title = EXCLUDED.title,
         artist_name = EXCLUDED.artist_name,
         duration_ms = EXCLUDED.duration_ms,
         requested_by = EXCLUDED.requested_by,
         -- 已 failed 的任务重新点"加入曲库"时复活重跑;ready/processing 保持原状
         status = CASE WHEN online_supplement_tasks.status = 'failed' THEN 'discovered' ELSE online_supplement_tasks.status END,
         stage = CASE WHEN online_supplement_tasks.status = 'failed' THEN 'download' ELSE online_supplement_tasks.stage END,
         stage_status = CASE WHEN online_supplement_tasks.status = 'failed' THEN 'pending' ELSE online_supplement_tasks.stage_status END,
         stage_progress_percent = CASE WHEN online_supplement_tasks.status = 'failed' THEN 0 ELSE online_supplement_tasks.stage_progress_percent END,
         stage_message = CASE WHEN online_supplement_tasks.status = 'failed' THEN '' ELSE online_supplement_tasks.stage_message END,
         failure_reason = CASE WHEN online_supplement_tasks.status = 'failed' THEN NULL ELSE online_supplement_tasks.failure_reason END,
         failure_stage = CASE WHEN online_supplement_tasks.status = 'failed' THEN NULL ELSE online_supplement_tasks.failure_stage END,
         llm_renamed_title = CASE WHEN online_supplement_tasks.status = 'failed' THEN NULL ELSE online_supplement_tasks.llm_renamed_title END,
         final_file_path = CASE WHEN online_supplement_tasks.status = 'failed' THEN NULL ELSE online_supplement_tasks.final_file_path END,
         lyric_file = CASE WHEN online_supplement_tasks.status = 'failed' THEN NULL ELSE online_supplement_tasks.lyric_file END,
         ready_song_id = CASE WHEN online_supplement_tasks.status = 'failed' THEN NULL ELSE online_supplement_tasks.ready_song_id END,
         download_at = CASE WHEN online_supplement_tasks.status = 'failed' THEN NULL ELSE online_supplement_tasks.download_at END,
         failed_at = CASE WHEN online_supplement_tasks.status = 'failed' THEN NULL ELSE online_supplement_tasks.failed_at END
       RETURNING ${TASK_COLUMNS}`,
      [
        input.roomId,
        input.provider,
        input.providerCandidateId,
        input.sourceUrl,
        input.title,
        input.artistName,
        input.durationMs,
        JSON.stringify(input.providerPayload),
        input.workflowId,
        input.requestedBy
      ]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("Online supplement task insert did not return a row");
    }
    return mapRowToTask(row);
  }

  async claimForStage(input: ClaimStageInput): Promise<OnlineSupplementTask | null> {
    const result = await this.db.query<OnlineSupplementTaskRow>(
      `UPDATE online_supplement_tasks
       SET worker_id = $2,
           worker_lease_until = $3,
           stage_status = 'running',
           status = 'processing',
           updated_at = now()
       WHERE id IN (
         SELECT id FROM online_supplement_tasks
         WHERE stage = $1
           AND stage_status = 'pending'
           AND status IN ('discovered', 'processing')
         ORDER BY updated_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING ${TASK_COLUMNS}`,
      [input.stage, input.workerId, input.leaseUntil]
    );
    return result.rows[0] ? mapRowToTask(result.rows[0]) : null;
  }

  async claimBatchForStage(input: ClaimBatchStageInput): Promise<OnlineSupplementTask[]> {
    const result = await this.db.query<OnlineSupplementTaskRow>(
      `UPDATE online_supplement_tasks
       SET worker_id = $2,
           worker_lease_until = $3,
           stage_status = 'running',
           status = 'processing',
           updated_at = now()
       WHERE id IN (
         SELECT id FROM online_supplement_tasks
         WHERE stage = $1
           AND stage_status = 'pending'
           AND status IN ('discovered', 'processing')
         ORDER BY updated_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $4
       )
       RETURNING ${TASK_COLUMNS}`,
      [input.stage, input.workerId, input.leaseUntil, input.batchSize]
    );
    return result.rows.map(mapRowToTask);
  }

  async renewLease(input: RenewLeaseInput): Promise<void> {
    await this.db.query(
      `UPDATE online_supplement_tasks
       SET worker_lease_until = $2, updated_at = now()
       WHERE id = $1 AND worker_id = $3 AND stage_status = 'running'`,
      [input.taskId, input.leaseUntil, input.workerId]
    );
  }

  async updateStageProgress(input: UpdateProgressInput): Promise<void> {
    const percent = Math.max(0, Math.min(100, Math.trunc(input.percent)));
    await this.db.query(
      `UPDATE online_supplement_tasks
       SET stage_progress_percent = $2,
           stage_message = $3,
           status = 'processing',
           updated_at = now()
       WHERE id = $1`,
      [input.taskId, percent, input.message]
    );
  }

  async completeStage(input: CompleteStageInput): Promise<void> {
    await this.db.query(
      `UPDATE online_supplement_tasks
       SET stage = $2,
           stage_status = 'pending',
           stage_progress_percent = 0,
           stage_message = $3,
           llm_renamed_title = COALESCE($4, llm_renamed_title),
           final_file_path = COALESCE($5, final_file_path),
           lyric_file = COALESCE($6, lyric_file),
           status = 'processing',
           updated_at = now()
       WHERE id = $1`,
      [
        input.taskId,
        input.nextStage,
        input.stageMessage ?? "",
        input.llmRenamedTitle ?? null,
        input.finalFilePath ?? null,
        input.lyricFile ?? null
      ]
    );
  }

  async markReady(input: MarkReadyInput): Promise<void> {
    await this.db.query(
      `UPDATE online_supplement_tasks
       SET status = 'ready',
           stage_status = 'done',
           stage_progress_percent = 100,
           ready_song_id = $2,
           final_file_path = $3,
           lyric_file = $4,
           ready_at = $5,
           worker_id = NULL,
           worker_lease_until = NULL,
           updated_at = now()
       WHERE id = $1`,
      [input.taskId, input.readySongId, input.finalFilePath, input.lyricFile, input.now]
    );
  }

  async markFailed(input: MarkFailedInput): Promise<void> {
    await this.db.query(
      `UPDATE online_supplement_tasks
       SET status = 'failed',
           stage_status = 'failed',
           failure_reason = $3,
           failure_stage = $2,
           failed_at = $4,
           worker_id = NULL,
           worker_lease_until = NULL,
           updated_at = now()
       WHERE id = $1`,
      [input.taskId, input.failureStage, input.reason, input.now]
    );
  }

  async reclaimStaleLeases(now: Date): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      `WITH reclaimed AS (
         UPDATE online_supplement_tasks
         SET stage_status = 'pending',
             worker_id = NULL,
             worker_lease_until = NULL,
             updated_at = now()
         WHERE stage_status = 'running'
           AND worker_lease_until IS NOT NULL
           AND worker_lease_until < $1
         RETURNING 1
       )
       SELECT count(*)::text AS count FROM reclaimed`,
      [now]
    );
    return Number.parseInt(result.rows[0]?.count ?? "0", 10);
  }

  async listRecentByRoom(roomId: RoomId, limit: number): Promise<OnlineSupplementTaskSummary[]> {
    const result = await this.db.query<OnlineSupplementTaskRow>(
      `SELECT ${TASK_COLUMNS}
       FROM online_supplement_tasks
       WHERE room_id = $1
       ORDER BY updated_at DESC
       LIMIT $2`,
      [roomId, limit]
    );
    return result.rows.map(mapRowToSummary);
  }

  async findById(taskId: string): Promise<OnlineSupplementTask | null> {
    const result = await this.db.query<OnlineSupplementTaskRow>(
      `SELECT ${TASK_COLUMNS}
       FROM online_supplement_tasks
       WHERE id = $1
       LIMIT 1`,
      [taskId]
    );
    return result.rows[0] ? mapRowToTask(result.rows[0]) : null;
  }
}

export function summarizeSupplementTasks(
  tasks: readonly OnlineSupplementTaskSummary[]
): RoomOnlineSupplementTaskSummary {
  const counts: Record<string, number> = { total: tasks.length };
  for (const task of tasks) {
    counts[task.status] = (counts[task.status] ?? 0) + 1;
  }
  return { counts, tasks };
}

export class InMemoryOnlineSupplementTaskRepository implements OnlineSupplementTaskRepository {
  private readonly tasks = new Map<string, OnlineSupplementTask>();

  async createTask(input: CreateSupplementTaskInput): Promise<OnlineSupplementTask> {
    const existing = Array.from(this.tasks.values()).find(
      (task) =>
        task.roomId === input.roomId &&
        task.provider === input.provider &&
        task.providerCandidateId === input.providerCandidateId
    );
    if (existing) {
      if (existing.status === "failed") {
        const resurrected: OnlineSupplementTask = {
          ...existing,
          title: input.title,
          artistName: input.artistName,
          durationMs: input.durationMs,
          requestedBy: input.requestedBy,
          status: "discovered",
          stage: "download",
          stageStatus: "pending",
          stageProgressPercent: 0,
          stageMessage: "",
          failureReason: null,
          failureStage: null,
          llmRenamedTitle: null,
          finalFilePath: null,
          lyricFile: null,
          readySongId: null,
          downloadAt: null,
          failedAt: null,
          updatedAt: input.now.toISOString()
        };
        this.tasks.set(existing.id, resurrected);
        return { ...resurrected };
      }
      return { ...existing, updatedAt: input.now.toISOString() };
    }

    const nowIso = input.now.toISOString();
    const task: OnlineSupplementTask = {
      id: `supplement-${this.tasks.size + 1}-${Date.now()}`,
      roomId: input.roomId,
      provider: input.provider,
      providerCandidateId: input.providerCandidateId,
      sourceUrl: input.sourceUrl,
      title: input.title,
      artistName: input.artistName,
      durationMs: input.durationMs,
      providerPayload: input.providerPayload,
      workflowId: input.workflowId,
      status: "discovered",
      stage: "download",
      stageStatus: "pending",
      stageProgressPercent: 0,
      stageMessage: "",
      failureReason: null,
      failureStage: null,
      llmRenamedTitle: null,
      finalFilePath: null,
      lyricFile: null,
      readySongId: null,
      workerId: null,
      workerLeaseUntil: null,
      requestedBy: input.requestedBy,
      downloadAt: null,
      readyAt: null,
      failedAt: null,
      createdAt: nowIso,
      updatedAt: nowIso
    };
    this.tasks.set(task.id, task);
    return { ...task };
  }

  async claimForStage(input: ClaimStageInput): Promise<OnlineSupplementTask | null> {
    const candidate = this.findClaimable(input.stage);
    if (!candidate) {
      return null;
    }
    const updated = this.applyClaim(candidate, input.workerId, input.leaseUntil, input.now);
    return { ...updated };
  }

  async claimBatchForStage(input: ClaimBatchStageInput): Promise<OnlineSupplementTask[]> {
    const claimed: OnlineSupplementTask[] = [];
    for (let index = 0; index < input.batchSize; index += 1) {
      const candidate = this.findClaimable(input.stage);
      if (!candidate) {
        break;
      }
      const updated = this.applyClaim(candidate, input.workerId, input.leaseUntil, input.now);
      claimed.push({ ...updated });
    }
    return claimed;
  }

  private findClaimable(stage: SupplementTaskStage): OnlineSupplementTask | null {
    const candidates = Array.from(this.tasks.values())
      .filter(
        (task) =>
          task.stage === stage &&
          task.stageStatus === "pending" &&
          (task.status === "discovered" || task.status === "processing")
      )
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    return candidates[0] ?? null;
  }

  private applyClaim(
    task: OnlineSupplementTask,
    workerId: string,
    leaseUntil: Date,
    now: Date
  ): OnlineSupplementTask {
    const updated: OnlineSupplementTask = {
      ...task,
      workerId,
      workerLeaseUntil: leaseUntil.toISOString(),
      stageStatus: "running",
      status: "processing",
      updatedAt: now.toISOString()
    };
    this.tasks.set(task.id, updated);
    return updated;
  }

  async renewLease(input: RenewLeaseInput): Promise<void> {
    const task = this.tasks.get(input.taskId);
    if (!task || task.workerId !== input.workerId || task.stageStatus !== "running") {
      return;
    }
    this.tasks.set(input.taskId, {
      ...task,
      workerLeaseUntil: input.leaseUntil.toISOString(),
      updatedAt: input.now.toISOString()
    });
  }

  async updateStageProgress(input: UpdateProgressInput): Promise<void> {
    const task = this.tasks.get(input.taskId);
    if (!task) {
      return;
    }
    const percent = Math.max(0, Math.min(100, Math.trunc(input.percent)));
    this.tasks.set(input.taskId, {
      ...task,
      stageProgressPercent: percent,
      stageMessage: input.message,
      status: "processing",
      updatedAt: input.now.toISOString()
    });
  }

  async completeStage(input: CompleteStageInput): Promise<void> {
    const task = this.tasks.get(input.taskId);
    if (!task) {
      return;
    }
    this.tasks.set(input.taskId, {
      ...task,
      stage: input.nextStage,
      stageStatus: "pending",
      stageProgressPercent: 0,
      stageMessage: input.stageMessage ?? "",
      llmRenamedTitle: input.llmRenamedTitle ?? task.llmRenamedTitle,
      finalFilePath: input.finalFilePath ?? task.finalFilePath,
      lyricFile: input.lyricFile ?? task.lyricFile,
      status: "processing",
      updatedAt: input.now.toISOString()
    });
  }

  async markReady(input: MarkReadyInput): Promise<void> {
    const task = this.tasks.get(input.taskId);
    if (!task) {
      return;
    }
    this.tasks.set(input.taskId, {
      ...task,
      status: "ready",
      stageStatus: "done",
      stageProgressPercent: 100,
      readySongId: input.readySongId,
      finalFilePath: input.finalFilePath,
      lyricFile: input.lyricFile,
      readyAt: input.now.toISOString(),
      workerId: null,
      workerLeaseUntil: null,
      updatedAt: input.now.toISOString()
    });
  }

  async markFailed(input: MarkFailedInput): Promise<void> {
    const task = this.tasks.get(input.taskId);
    if (!task) {
      return;
    }
    this.tasks.set(input.taskId, {
      ...task,
      status: "failed",
      stageStatus: "failed",
      failureReason: input.reason,
      failureStage: input.failureStage,
      failedAt: input.now.toISOString(),
      workerId: null,
      workerLeaseUntil: null,
      updatedAt: input.now.toISOString()
    });
  }

  async reclaimStaleLeases(now: Date): Promise<number> {
    let count = 0;
    const nowMs = now.getTime();
    for (const [id, task] of this.tasks) {
      if (
        task.stageStatus === "running" &&
        task.workerLeaseUntil &&
        new Date(task.workerLeaseUntil).getTime() < nowMs
      ) {
        this.tasks.set(id, {
          ...task,
          stageStatus: "pending",
          workerId: null,
          workerLeaseUntil: null,
          updatedAt: now.toISOString()
        });
        count += 1;
      }
    }
    return count;
  }

  async listRecentByRoom(roomId: RoomId, limit: number): Promise<OnlineSupplementTaskSummary[]> {
    return Array.from(this.tasks.values())
      .filter((task) => task.roomId === roomId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit)
      .map((task) => this.toSummary(task));
  }

  async findById(taskId: string): Promise<OnlineSupplementTask | null> {
    const task = this.tasks.get(taskId);
    return task ? { ...task } : null;
  }

  private toSummary(task: OnlineSupplementTask): OnlineSupplementTaskSummary {
    return {
      taskId: task.id,
      roomId: task.roomId,
      provider: task.provider,
      providerCandidateId: task.providerCandidateId,
      title: task.llmRenamedTitle ?? task.title,
      artistName: task.artistName,
      durationMs: task.durationMs,
      workflowId: task.workflowId,
      status: task.status,
      stage: task.stage,
      stageProgressPercent: task.stageProgressPercent,
      stageMessage: task.stageMessage,
      failureReason: task.failureReason,
      llmRenamedTitle: task.llmRenamedTitle,
      readySongId: task.readySongId,
      lyricFile: task.lyricFile,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt
    };
  }
}
