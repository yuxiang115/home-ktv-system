import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { OnlineSupplementTask } from "@home-ktv/domain";
import type { OnlineProvider, OnlineSearchCandidate } from "../online-provider.js";
import { isEnvironmentSpawnFailure } from "../providers/yt-dlp-provider.js";
import type { StageExecuteInput, StageExecuteResult, StageHandler } from "../supplement-orchestrator.js";

const DOWNLOAD_SUBDIR = "_downloads";
// M3:每次下载尝试前后都把租约顶到尝试窗口之外,防止长下载期间租约过期
// 被 reclaimStaleLeases 回收、任务被其他 worker 重新认领后双跑
const ATTEMPT_LEASE_EXTENSION_MS = 5 * 60 * 1000;

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
      // M3:尝试开始前也续约(不只尝试之间),补上首次尝试与重试间隔后的续约缺口
      await input.renewLease(new Date(Date.now() + ATTEMPT_LEASE_EXTENSION_MS));
      await input.reportProgress(10 + (attempt - 1) * 15, `download (attempt ${attempt}/3)`);
      try {
        input.log(`download attempt ${attempt}/3`, { url: candidate.sourceUrl, destPath });
        await this.options.provider.download({ candidate, destPath });
        input.log(`download attempt ${attempt}/3 ok`, { destPath });
        await input.reportProgress(95, "download complete");
        return { status: "completed", message: "downloaded" };
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        input.log(`download attempt ${attempt}/3 failed`, {
          url: candidate.sourceUrl,
          error: message.slice(0, 400)
        });
        // 环境级失败(下载器进程起不来)重试无意义,立即失败并给出人话原因
        if (isEnvironmentSpawnFailure(message)) {
          return {
            status: "failed",
            failureReason: `下载器启动失败(本机环境问题,重启服务可恢复): ${message.slice(0, 300)}`
          };
        }
        if (attempt < 3) {
          await input.renewLease(new Date(Date.now() + ATTEMPT_LEASE_EXTENSION_MS));
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
