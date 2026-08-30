import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { downloadedAssetPath } from "./download-handler.js";
import type { StageExecuteInput, StageExecuteResult, StageHandler } from "../supplement-orchestrator.js";
import { defaultStageCommandRunner, type StageCommandRunner } from "./vocal-remove-handler.js";

const STEMS_SUBDIR = "_stems";
const MIXED_SUBDIR = "_mixed";
const DEFAULT_MODEL = "htdemucs";

export interface MixStageHandlerOptions {
  ffmpegBin?: string;
  workDir: string;
  model?: string;
  timeoutMs?: number;
  run?: StageCommandRunner;
}

export class MixStageHandler implements StageHandler {
  readonly stage = "mix" as const;

  private readonly options: MixStageHandlerOptions;
  private readonly run: StageCommandRunner;

  constructor(options: MixStageHandlerOptions) {
    this.options = options;
    this.run = options.run ?? defaultStageCommandRunner;
  }

  async execute(input: StageExecuteInput): Promise<StageExecuteResult> {
    const original = downloadedAssetPath(this.options.workDir, input.task.id);
    const model = this.options.model ?? DEFAULT_MODEL;
    const accompaniment = path.join(
      this.options.workDir,
      STEMS_SUBDIR,
      input.task.id,
      model,
      input.task.id,
      "no_vocals.wav"
    );
    const mixedDir = path.join(this.options.workDir, MIXED_SUBDIR);
    await mkdir(mixedDir, { recursive: true });
    const output = path.join(mixedDir, `${input.task.id}.mkv`);

    if (!(await stat(original).catch(() => null))) {
      return { status: "failed", failureReason: `original track not found: ${original}` };
    }
    if (!(await stat(accompaniment).catch(() => null))) {
      return { status: "failed", failureReason: `accompaniment not found: ${accompaniment}` };
    }

    // 视频 copy;原唱用原 mkv 的音轨 (轨0);伴奏用 Demucs 的 no_vocals (轨1)。
    // 音轨 title 标 "原唱"/"伴奏",inferTrackRolesFromRealMv 的正则会自动识别角色,
    // 这样播放端能切原唱/伴唱。
    const args = [
      "-y",
      "-i",
      original,
      "-i",
      accompaniment,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-metadata:s:a:0",
      "title=原唱",
      "-metadata:s:a:1",
      "title=伴奏",
      output
    ];

    await input.reportProgress(30, "mixing dual-track mkv");
    // M3:ffmpeg 可能跑满整个超时窗口(默认 5min),执行前先把租约顶到窗口之外,
    // 防止中途租约过期被 reclaim 后任务被其他 worker 重新认领导致双跑
    await input.renewLease(new Date(Date.now() + 10 * 60 * 1000));
    input.log("ffmpeg mix start", { original, accompaniment, output });
    try {
      await this.run(this.options.ffmpegBin ?? "ffmpeg", args, this.options.timeoutMs ?? 5 * 60 * 1000);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      input.log("ffmpeg mix failed", { output, error: msg });
      return { status: "failed", failureReason: `ffmpeg mix failed: ${msg}` };
    }

    const outputStats = await stat(output).catch(() => null);
    if (!outputStats) {
      input.log("ffmpeg mix produced no output", { output });
      return { status: "failed", failureReason: `ffmpeg produced no output at ${output}` };
    }
    input.log("ffmpeg mix done", { output, sizeBytes: outputStats.size });

    await input.reportProgress(95, "dual-track mixed");
    return { status: "completed", message: "mixed", finalFilePath: output };
  }
}
