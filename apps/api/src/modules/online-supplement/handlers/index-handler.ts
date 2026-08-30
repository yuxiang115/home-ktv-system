import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { MediaPathMapping } from "../../assets/media-path-mapping.js";
import type { QueryExecutor } from "../../../db/query-executor.js";
import { buildKtvIndexAssetDraft, indexKtvAssetDrafts } from "../../ingest/ktv-full-index.js";
import { KtvIndexTechnicalProbeService } from "../../ktv-index/ktv-index-technical-probe.js";
import { downloadedAssetPath } from "./download-handler.js";
import { STEMS_SUBDIR, karaokeJsonLooksValid, vocalsStemPath } from "./align-handler.js";
import { defaultStageCommandRunner, type StageCommandRunner } from "../process-runner.js";
import {
  cleanupSupplementIntermediates,
  type StageExecuteInput,
  type StageExecuteResult,
  type StageHandler
} from "../supplement-orchestrator.js";

const ONLINE_SUBDIR = "_online";
const MIXED_SUBDIR = "_mixed";
const LYRICS_SUBDIR = "_lyrics";
// 曲库人声 sidecar:index 前把 vocals stem 压缩成小体积 m4a 留在 mkv 旁。
// 没有它,入库清理后 vocals.wav 消失,backfill 重对齐只能用混音 mkv(质量退化)。
export const VOCALS_SIDECAR_SUFFIX = ".vocals.m4a";
const DEFAULT_DEMUCS_MODEL = "htdemucs";

export interface IndexStageHandlerOptions {
  db: QueryExecutor;
  workDir: string;
  pathMappings?: readonly MediaPathMapping[];
  /** 压缩人声 sidecar 用的 ffmpeg(缺省 "ffmpeg") */
  ffmpegBin?: string;
  /** 定位 vocals stem 的 demucs 模型名(缺省 htdemucs;找不到时扫 _stems 全模型) */
  demucsModel?: string;
  timeoutMs?: number;
  run?: StageCommandRunner;
}

export class IndexStageHandler implements StageHandler {
  readonly stage = "index" as const;

  private readonly options: IndexStageHandlerOptions;
  private readonly run: StageCommandRunner;

  constructor(options: IndexStageHandlerOptions) {
    this.options = options;
    this.run = options.run ?? defaultStageCommandRunner;
  }

  async execute(input: StageExecuteInput): Promise<StageExecuteResult> {
    const specName = input.task.llmRenamedTitle ?? input.task.title;
    const safeName = sanitizeFileName(specName);
    const onlineDir = path.join(this.options.workDir, ONLINE_SUBDIR);
    await mkdir(onlineDir, { recursive: true });
    const finalFilePath = path.join(onlineDir, `${safeName}.mkv`);
    const mixedPath = path.join(this.options.workDir, MIXED_SUBDIR, `${input.task.id}.mkv`);
    // enhanced workflow: mix 阶段产出双音轨 mkv 到 _mixed;basic workflow: 用 download 的 _downloads
    const srcPath = (await stat(mixedPath).catch(() => null))
      ? mixedPath
      : downloadedAssetPath(this.options.workDir, input.task.id);

    await input.reportProgress(20, "copying asset into library");
    input.log("index copy start", { from: srcPath, to: finalFilePath });
    try {
      await copyFile(srcPath, finalFilePath);
    } catch (error) {
      input.log("index copy failed", {
        from: srcPath,
        to: finalFilePath,
        error: error instanceof Error ? error.message : String(error)
      });
      return {
        status: "failed",
        failureReason: `index copy failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }

    const stats = await stat(finalFilePath).catch(() => null);
    input.log("index copy done", { finalFilePath, sizeBytes: stats?.size ?? null });
    await input.reportProgress(50, "indexing into ktv_songs");
    const draft = buildKtvIndexAssetDraft({
      sourcePath: finalFilePath,
      relativePath: `${ONLINE_SUBDIR}/${safeName}.mkv`,
      sizeBytes: stats?.size ?? null,
      mtimeMs: stats?.mtimeMs != null ? Math.trunc(stats.mtimeMs) : null
    });
    await indexKtvAssetDrafts(this.options.db, {
      sourceRoot: this.options.workDir,
      drafts: [draft],
      markMissingAssets: false,
      preserveExisting: false
    });

    await input.reportProgress(80, "locating song id");
    const result = await this.options.db.query<{ id: string }>(
      "SELECT id FROM ktv_songs WHERE file_path = $1 LIMIT 1",
      [finalFilePath]
    );
    const readySongId = result.rows[0]?.id;
    if (!readySongId) {
      input.log("indexed song not found by file_path", { finalFilePath });
      return { status: "failed", failureReason: "indexed song not found by file_path" };
    }
    input.log("song indexed", { readySongId, finalFilePath });

    const finalLyricFile = await this.copyLyricIntoLibrary(input.task, onlineDir, safeName, readySongId);
    await this.copyKaraokeIntoLibrary(input.task.id, onlineDir, safeName, readySongId, input.log);
    await this.preserveVocalsSidecar(input.task.id, onlineDir, safeName, input.log);

    // 入库后立刻 ffprobe,填 technical_metadata;否则 compatibility 判为 unsupported、
    // 点歌链路 (isQueueablePlayableMedia) 会拒绝。
    await input.reportProgress(90, "probing media tracks");
    try {
      const probeService = new KtvIndexTechnicalProbeService(this.options.db, {
        ...(this.options.pathMappings ? { pathMappings: this.options.pathMappings } : {})
      });
      const probeResult = await probeService.probeKtvIndexAssets({ assetId: readySongId, limit: 1 });
      // probe 内部消化单文件失败(technical_status='failed'),只有返回计数能暴露问题。
      // 歌已入库所以任务仍算 completed,但 message 必须写明,否则 UI 显示完成、
      // 点歌却被 SONG_NOT_QUEUEABLE 拒绝时无从排查。
      if (probeResult.failed > 0) {
        input.log("probe reported failures", {
          readySongId,
          failed: probeResult.failed,
          selected: probeResult.selected,
          probed: probeResult.probed,
          skipped: probeResult.skipped
        });
        return {
          status: "completed",
          message: `indexed (probe failed ${probeResult.failed}/${probeResult.selected} — 该歌可能无法点播，请重跑 probe)`,
          readySongId,
          finalFilePath,
          ...(finalLyricFile ? { lyricFile: finalLyricFile } : {})
        };
      }
    } catch (error) {
      return {
        status: "completed",
        message: `indexed (probe failed: ${error instanceof Error ? error.message : String(error)})`,
        readySongId,
        finalFilePath,
        ...(finalLyricFile ? { lyricFile: finalLyricFile } : {})
      };
    }

    await cleanupSupplementIntermediates(this.options.workDir, input.task.id);
    input.log("intermediates cleaned", { taskId: input.task.id });

    return {
      status: "completed",
      message: "indexed",
      readySongId,
      finalFilePath,
      ...(finalLyricFile ? { lyricFile: finalLyricFile } : {})
    };
  }

  // align 阶段产出按约定在 _lyrics/<taskId>.karaoke.json;拷为曲库 sidecar 并落
  // ktv_songs.karaoke_lyrics_file。缺失(未配置 aligner/basic 工作流)静默跳过。
  private async copyKaraokeIntoLibrary(
    taskId: string,
    onlineDir: string,
    safeName: string,
    readySongId: string,
    log?: (message: string, meta?: Record<string, unknown>) => void
  ): Promise<void> {
    const source = path.join(this.options.workDir, LYRICS_SUBDIR, `${taskId}.karaoke.json`);
    if (!(await stat(source).catch(() => null))) {
      log?.("karaoke sidecar missing (skip)", { source });
      return;
    }
    if (!(await karaokeJsonLooksValid(source))) {
      // 半截/空 JSON 一旦入库,backfill 按 karaoke_lyrics_file IS NULL 过滤就永远不再修复
      log?.("karaoke sidecar invalid (skip)", { source });
      return;
    }

    const dest = path.join(onlineDir, `${safeName}.karaoke.json`);
    try {
      await copyFile(source, dest);
      await this.options.db.query(
        "UPDATE ktv_songs SET karaoke_lyrics_file = $1, updated_at = now() WHERE id = $2",
        [dest, readySongId]
      );
      log?.("karaoke sidecar copied", { from: source, to: dest, readySongId });
    } catch (error) {
      // best-effort: 失败仅意味着 TV 降级到行级 LRC,但必须留痕
      log?.("karaoke sidecar copy failed", {
        from: source,
        to: dest,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  // 入库清理会删掉 _stems/<taskId>(vocals.wav 就在里面)。清理前把人声 stem
  // 压缩成 16k mono aac 留在曲库 mkv 旁,backfill 重对齐时优先用它(比混音 mkv
  // 质量好得多,又不用重跑分钟级的 demucs)。best-effort:失败仅日志。
  private async preserveVocalsSidecar(
    taskId: string,
    onlineDir: string,
    safeName: string,
    log?: (message: string, meta?: Record<string, unknown>) => void
  ): Promise<void> {
    const source = await this.findVocalsStem(taskId);
    if (!source) {
      log?.("vocals stem missing (skip sidecar)", { taskId });
      return;
    }

    const dest = path.join(onlineDir, `${safeName}${VOCALS_SIDECAR_SUFFIX}`);
    try {
      await this.run(
        this.options.ffmpegBin ?? "ffmpeg",
        [
          "-y",
          "-nostdin",
          "-i",
          source,
          "-vn",
          "-ac",
          "1",
          "-ar",
          "16000",
          "-c:a",
          "aac",
          dest
        ],
        this.options.timeoutMs ?? 5 * 60 * 1000
      );
      log?.("vocals sidecar saved", { from: source, to: dest });
    } catch (error) {
      log?.("vocals sidecar save failed", {
        from: source,
        to: dest,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  // vocal_remove 的产物布局是 _stems/<taskId>/<model>/<taskId>/vocals.wav;模型名
  // 由配置决定,优先看配置的模型目录,再扫一遍 _stems 兜底(配置漂移时仍能找到)。
  private async findVocalsStem(taskId: string): Promise<string | null> {
    const preferred = this.options.demucsModel ?? DEFAULT_DEMUCS_MODEL;
    const configured = vocalsStemPath(this.options.workDir, taskId, preferred);
    if ((await stat(configured).catch(() => null)) != null) {
      return configured;
    }
    const stemsDir = path.join(this.options.workDir, STEMS_SUBDIR, taskId);
    const modelDirs = await readdir(stemsDir).catch(() => [] as string[]);
    for (const model of modelDirs.sort()) {
      if (model === preferred) {
        continue;
      }
      const candidate = vocalsStemPath(this.options.workDir, taskId, model);
      if ((await stat(candidate).catch(() => null)) != null) {
        return candidate;
      }
    }
    return null;
  }

  private async copyLyricIntoLibrary(
    task: StageExecuteInput["task"],
    onlineDir: string,
    safeName: string,
    readySongId: string
  ): Promise<string | null> {
    const source = task.lyricFile ?? path.join(this.options.workDir, LYRICS_SUBDIR, `${task.id}.lrc`);
    if (!(await stat(source).catch(() => null))) {
      return null;
    }

    const lyricDest = path.join(onlineDir, `${safeName}.lrc`);
    try {
      await copyFile(source, lyricDest);
      await this.options.db.query(
        "UPDATE ktv_songs SET lyric_file = $1, updated_at = now() WHERE id = $2",
        [lyricDest, readySongId]
      );
    } catch {
      return null;
    }
    return lyricDest;
  }
}

function sanitizeFileName(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]/gu, "_")
    .replace(/\s+/gu, " ")
    .trim();
}
