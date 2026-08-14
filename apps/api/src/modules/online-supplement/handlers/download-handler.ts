import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { OnlineSupplementTask } from "@home-ktv/domain";
import type { OnlineProvider, OnlineSearchCandidate } from "../online-provider.js";
import type { StageExecuteInput, StageExecuteResult, StageHandler } from "../supplement-orchestrator.js";

const DOWNLOAD_SUBDIR = "_downloads";

export function downloadedAssetPath(workDir: string, taskId: string): string {
  return path.join(workDir, DOWNLOAD_SUBDIR, `${taskId}.mkv`);
}

export function taskToCandidate(task: OnlineSupplementTask): OnlineSearchCandidate {
  return {
    provider: task.provider,
    providerCandidateId: task.providerCandidateId,
    sourceUrl: task.sourceUrl,
    title: task.title,
    artistName: task.artistName,
    durationMs: task.durationMs,
    providerPayload: task.providerPayload
  };
}

export interface DownloadStageHandlerOptions {
  provider: OnlineProvider;
  workDir: string;
}

export class DownloadStageHandler implements StageHandler {
  readonly stage = "download" as const;

  constructor(private readonly options: DownloadStageHandlerOptions) {}

  async execute(input: StageExecuteInput): Promise<StageExecuteResult> {
    const dir = path.join(this.options.workDir, DOWNLOAD_SUBDIR);
    await mkdir(dir, { recursive: true });
    const destPath = downloadedAssetPath(this.options.workDir, input.task.id);
    const candidate = taskToCandidate(input.task);

    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await input.reportProgress(10 + (attempt - 1) * 15, `download (attempt ${attempt}/3)`);
      try {
        await this.options.provider.download({ candidate, destPath });
        await input.reportProgress(95, "download complete");
        return { status: "completed", message: "downloaded" };
      } catch (error) {
        lastError = error;
        if (attempt < 3) {
          await input.renewLease(new Date(Date.now() + 5 * 60 * 1000));
          await sleep(3000 * attempt);
        }
      }
    }
    return {
      status: "failed",
      failureReason: `download failed after retries: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
