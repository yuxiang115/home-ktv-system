import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import * as OpenCC from "opencc-js";
import { defaultStageCommandRunner, type StageCommandRunner } from "./vocal-remove-handler.js";
import { SidecarTransportError, type PythonSidecar } from "../python-sidecar.js";
import type { StageExecuteInput, StageExecuteResult, StageHandler } from "../supplement-orchestrator.js";

// align 阶段产出固定放在 _lyrics/<taskId>.karaoke.json(index 阶段按约定读取,
// 不经过 tasks 表加列透传)
export const STEMS_SUBDIR = "_stems";
export const LYRICS_SUBDIR = "_lyrics";
export const KARAOKE_FILENAME_SUFFIX = ".karaoke.json";

export function karaokeJsonPath(workDir: string, taskId: string): string {
  return path.join(workDir, LYRICS_SUBDIR, `${taskId}${KARAOKE_FILENAME_SUFFIX}`);
}

export function vocalsStemPath(workDir: string, taskId: string, model: string): string {
  return path.join(workDir, STEMS_SUBDIR, taskId, model, taskId, "vocals.wav");
}

// 规范名第 3 段语种 → ForcedAligner 语言名(支持:Chinese/Cantonese/English/
// French/German/Italian/Japanese/Korean/Portuguese/Russian/Spanish)
const LANGUAGE_BY_MARKER: Record<string, string> = {
  国语: "Chinese",
  普通话: "Chinese",
  国: "Chinese",
  囯语: "Chinese",
  闽南语: "Chinese",
  闽南: "Chinese",
  闽语: "Chinese",
  台语: "Chinese",
  粤语: "Cantonese",
  英语: "English",
  日语: "Japanese",
  韩语: "Korean",
  法语: "French",
  德语: "German",
  意大利语: "Italian",
  西班牙语: "Spanish",
  俄语: "Russian",
  葡萄牙语: "Portuguese"
};

export function alignerLanguageForSpecName(specName: string | null): string {
  if (!specName) {
    return "Chinese";
  }
  const parts = specName.split("-").map((part) => part.trim());
  // 规范名常见繁体(國語/粵語/英語),先繁转简再查表;未知语种默认 Chinese
  const marker = traditionalToSimplified(parts[2] ?? "").replaceAll("_", "").trim();
  return LANGUAGE_BY_MARKER[marker] ?? "Chinese";
}

// index 阶段按"文件存在"拷贝 sidecar,截断/空 JSON 会永久污染 ktv_songs 行且
// backfill 不再重试,所以这里要求可解析且至少有一行
export async function karaokeJsonLooksValid(file: string): Promise<boolean> {
  try {
    const payload = JSON.parse(await readFile(file, "utf8")) as { lines?: unknown };
    return Array.isArray(payload?.lines) && payload.lines.length > 0;
  } catch {
    return false;
  }
}

const traditionalToSimplified = OpenCC.Converter({ from: "t", to: "cn" });

export interface AlignStageHandlerOptions {
  /** python 解释器(qwen-asr 已安装);空 = 未配置,阶段自跳过 */
  bin: string;
  /** 对齐脚本路径(apps/api/python/align_lyrics.py) */
  scriptPath: string;
  model: string;
  device: string;
  dtype: string;
  demucsModel: string;
  timeoutMs?: number;
  run?: StageCommandRunner;
  /** 常驻 sidecar 客户端(可选):配置未启用/未注入时不走 sidecar;
   * 传输层故障自动回退单次脚本路径,业务失败按旧路径语义处理 */
  sidecar?: PythonSidecar | null;
}

export class AlignStageHandler implements StageHandler {
  readonly stage = "align" as const;

  private readonly options: AlignStageHandlerOptions;
  private readonly run: StageCommandRunner;

  constructor(options: AlignStageHandlerOptions) {
    this.options = options;
    this.run = options.run ?? defaultStageCommandRunner;
  }

  async execute(input: StageExecuteInput): Promise<StageExecuteResult> {
    const out = karaokeJsonPath(input.workDir, input.task.id);
    // 上一轮尝试可能留下半成品(如超时被杀时 python 写了一半);本轮要么重新
    // 生成,要么删除,绝不让过期文件被 index 阶段当作本轮产物拷入库
    await rm(out, { force: true }).catch(() => undefined);

    if (!this.options.bin) {
      return { status: "completed", message: "align skipped (no aligner configured)" };
    }

    const vocals = vocalsStemPath(input.workDir, input.task.id, this.options.demucsModel);
    if (!(await stat(vocals).catch(() => null))) {
      return { status: "completed", message: `align skipped (no vocals stem)` };
    }
    const lrc = input.task.lyricFile ?? path.join(input.workDir, LYRICS_SUBDIR, `${input.task.id}.lrc`);
    if (!(await stat(lrc).catch(() => null))) {
      return { status: "completed", message: "align skipped (no lyrics)" };
    }

    const language = alignerLanguageForSpecName(input.task.llmRenamedTitle);
    input.log("align start", { vocals, lrc, out, language });
    await input.reportProgress(20, `逐字对齐(${language}, qwen3 aligner)`);
    // 首跑要下载模型权重,给足 lease 与超时(lease 与默认超时对齐为 20min)
    await input.renewLease(new Date(Date.now() + 20 * 60 * 1000));
    const timeoutMs = this.options.timeoutMs ?? 20 * 60 * 1000;

    // 优先走常驻 sidecar(模型已加载,秒级);传输层故障(进程崩溃/超时/broken)
    // 回退单次脚本路径,sidecar 故障绝不阻塞管线
    const sidecar = this.options.sidecar;
    let sidecarHandled = false;
    if (sidecar && !sidecar.isBroken()) {
      try {
        const response = await sidecar.align(
          {
            audio: vocals,
            lyrics: lrc,
            out,
            language,
            model: this.options.model,
            device: this.options.device,
            dtype: this.options.dtype
          },
          timeoutMs
        );
        sidecarHandled = true;
        if (!response.ok) {
          // 与单次脚本路径同语义:对齐失败不 fail 任务,lrc 兜底
          await rm(out, { force: true }).catch(() => undefined);
          const message = (response.error ?? "sidecar align failed").slice(0, 300);
          return { status: "completed", message: `align failed (best-effort, lrc fallback): ${message}` };
        }
        input.log("align via sidecar ok", { out });
      } catch (error) {
        if (!(error instanceof SidecarTransportError)) {
          throw error;
        }
        input.log("align sidecar transport failure; falling back to one-shot script", {
          error: error.message
        });
      }
    }

    if (!sidecarHandled) {
      const args = [
        this.options.scriptPath,
        "--audio",
        vocals,
        "--lyrics",
        lrc,
        "--out",
        out,
        "--language",
        language,
        "--model",
        this.options.model,
        "--device",
        this.options.device,
        "--dtype",
        this.options.dtype
      ];
      try {
        await this.run(this.options.bin, args, timeoutMs);
      } catch (error) {
        // 超时被 kill 时 python 可能已写了半截文件,删掉防止截断 JSON 入库
        await rm(out, { force: true }).catch(() => undefined);
        const message = error instanceof Error ? error.message : String(error);
        return { status: "completed", message: `align failed (best-effort, lrc fallback): ${message.slice(0, 300)}` };
      }
    }

    if (!(await stat(out).catch(() => null))) {
      input.log("align produced no output", { out });
      return { status: "completed", message: "align produced no output (lrc fallback)" };
    }
    if (!(await karaokeJsonLooksValid(out))) {
      await rm(out, { force: true }).catch(() => undefined);
      input.log("align output invalid (deleted)", { out });
      return { status: "completed", message: "align output invalid (lrc fallback)" };
    }

    input.log("align done", { out });
    await input.reportProgress(95, "逐字对齐完成");
    return { status: "completed", message: "aligned" };
  }
}
