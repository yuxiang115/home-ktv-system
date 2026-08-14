import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { MediaPathMapping } from "../../assets/media-path-mapping.js";
import type { QueryExecutor } from "../../../db/query-executor.js";
import { buildKtvIndexAssetDraft, indexKtvAssetDrafts } from "../../ingest/ktv-full-index.js";
import { KtvIndexTechnicalProbeService } from "../../ktv-index/ktv-index-technical-probe.js";
import { downloadedAssetPath } from "./download-handler.js";
import type { StageExecuteInput, StageExecuteResult, StageHandler } from "../supplement-orchestrator.js";

const ONLINE_SUBDIR = "_online";
const MIXED_SUBDIR = "_mixed";
const STEMS_SUBDIR = "_stems";
const LYRICS_SUBDIR = "_lyrics";

export interface IndexStageHandlerOptions {
  db: QueryExecutor;
  workDir: string;
  pathMappings?: readonly MediaPathMapping[];
}

export class IndexStageHandler implements StageHandler {
  readonly stage = "index" as const;

  constructor(private readonly options: IndexStageHandlerOptions) {}

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
    try {
      await copyFile(srcPath, finalFilePath);
    } catch (error) {
      return {
        status: "failed",
        failureReason: `index copy failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }

    const stats = await stat(finalFilePath).catch(() => null);
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
      return { status: "failed", failureReason: "indexed song not found by file_path" };
    }

    const finalLyricFile = await this.copyLyricIntoLibrary(input.task, onlineDir, safeName, readySongId);

    // 入库后立刻 ffprobe,填 technical_metadata;否则 compatibility 判为 unsupported、
    // 点歌链路 (isQueueablePlayableMedia) 会拒绝。
    await input.reportProgress(90, "probing media tracks");
    try {
      const probeService = new KtvIndexTechnicalProbeService(this.options.db, {
        ...(this.options.pathMappings ? { pathMappings: this.options.pathMappings } : {})
      });
      await probeService.probeKtvIndexAssets({ assetId: readySongId, limit: 1 });
    } catch (error) {
      return {
        status: "completed",
        message: `indexed (probe failed: ${error instanceof Error ? error.message : String(error)})`,
        readySongId,
        finalFilePath,
        ...(finalLyricFile ? { lyricFile: finalLyricFile } : {})
      };
    }

    await this.cleanupIntermediates(input.task.id);

    return {
      status: "completed",
      message: "indexed",
      readySongId,
      finalFilePath,
      ...(finalLyricFile ? { lyricFile: finalLyricFile } : {})
    };
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

  private async cleanupIntermediates(taskId: string): Promise<void> {
    await Promise.all([
      rm(path.join(this.options.workDir, "_downloads", `${taskId}.mkv`), { force: true }).catch(() => undefined),
      rm(path.join(this.options.workDir, STEMS_SUBDIR, taskId), { recursive: true, force: true }).catch(() => undefined),
      rm(path.join(this.options.workDir, MIXED_SUBDIR, `${taskId}.mkv`), { force: true }).catch(() => undefined),
      rm(path.join(this.options.workDir, LYRICS_SUBDIR, `${taskId}.lrc`), { force: true }).catch(() => undefined)
    ]);
  }
}

function sanitizeFileName(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]/gu, "_")
    .replace(/\s+/gu, " ")
    .trim();
}
