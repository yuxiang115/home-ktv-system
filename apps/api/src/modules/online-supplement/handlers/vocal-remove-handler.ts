import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { downloadedAssetPath } from "./download-handler.js";
import type { StageExecuteInput, StageExecuteResult, StageHandler } from "../supplement-orchestrator.js";

const execFileAsync = promisify(execFile);
const STEMS_SUBDIR = "_stems";
const DEFAULT_MODEL = "htdemucs";

export type StageCommandRunner = (
  bin: string,
  args: readonly string[],
  timeoutMs: number
) => Promise<void>;

export const defaultStageCommandRunner: StageCommandRunner = async (bin, args, timeoutMs) => {
  await execFileAsync(bin, args as string[], {
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024
  });
};

export interface VocalRemoveStageHandlerOptions {
  bin: string;
  binArgs?: string;
  device: string;
  workDir: string;
  model?: string;
  timeoutMs?: number;
  run?: StageCommandRunner;
}

export class VocalRemoveStageHandler implements StageHandler {
  readonly stage = "vocal_remove" as const;

  private readonly options: VocalRemoveStageHandlerOptions;
  private readonly run: StageCommandRunner;

  constructor(options: VocalRemoveStageHandlerOptions) {
    this.options = options;
    this.run = options.run ?? defaultStageCommandRunner;
  }

  async execute(input: StageExecuteInput): Promise<StageExecuteResult> {
    const src = downloadedAssetPath(this.options.workDir, input.task.id);
    const model = this.options.model ?? DEFAULT_MODEL;
    const outDir = path.join(this.options.workDir, STEMS_SUBDIR, input.task.id);
    await mkdir(outDir, { recursive: true });

    if (!(await stat(src).catch(() => null))) {
      return { status: "failed", failureReason: `source audio not found: ${src}` };
    }

    const prefix = this.options.binArgs ? this.options.binArgs.split(/\s+/u).filter(Boolean) : [];
    const args = [
      ...prefix,
      "--two-stems",
      "vocals",
      "-n",
      model,
      "-d",
      this.options.device,
      "-o",
      outDir,
      src
    ];
    const timeoutMs = this.options.timeoutMs ?? 15 * 60 * 1000;

    const deviceHint = this.options.device === "cpu" ? "cpu 模式较慢,约数分钟" : "gpu 加速";
    await input.reportProgress(10, `demucs ${this.options.device} (${deviceHint})`);

    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await input.renewLease(new Date(Date.now() + 15 * 60 * 1000));
      try {
        await this.run(this.options.bin, args, timeoutMs);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    }

    if (lastError) {
      const msg = lastError instanceof Error ? lastError.message : String(lastError);
      return { status: "failed", failureReason: `demucs failed: ${msg}` };
    }

    // 输出布局: <outDir>/<model>/<input-stem>/no_vocals.wav
    const accompaniment = path.join(outDir, model, input.task.id, "no_vocals.wav");
    if (!(await stat(accompaniment).catch(() => null))) {
      return { status: "failed", failureReason: `demucs produced no accompaniment at ${accompaniment}` };
    }

    await input.reportProgress(95, "vocal removed");
    return { status: "completed", message: "vocal removed" };
  }
}
