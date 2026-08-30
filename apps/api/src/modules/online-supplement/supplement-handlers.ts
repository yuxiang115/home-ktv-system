import type { SupplementTaskStage } from "@home-ktv/domain";
import type { MediaPathMapping } from "../assets/media-path-mapping.js";
import type { QueryExecutor } from "../../db/query-executor.js";
import type { OnlineProvider } from "./online-provider.js";
import type { StageHandler } from "./supplement-orchestrator.js";
import { DownloadStageHandler } from "./handlers/download-handler.js";
import { RenameLlmStageHandler } from "./handlers/rename-llm-handler.js";
import { LyricsStageHandler } from "./handlers/lyrics-handler.js";
import { VocalRemoveStageHandler } from "./handlers/vocal-remove-handler.js";
import { AlignStageHandler } from "./handlers/align-handler.js";
import { MixStageHandler } from "./handlers/mix-handler.js";
import { IndexStageHandler } from "./handlers/index-handler.js";

export interface SupplementLlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface SupplementHandlersOptions {
  provider: OnlineProvider;
  db: QueryExecutor;
  workDir: string;
  llm: SupplementLlmConfig;
  pathMappings?: readonly MediaPathMapping[];
  lrclibBaseUrl: string;
  demucsBin: string;
  demucsArgs?: string;
  demucsDevice: string;
  demucsModel: string;
  ffmpegBin?: string;
  aligner?: {
    bin: string;
    scriptPath: string;
    model: string;
    device: string;
    dtype: string;
  };
}

export function buildSupplementHandlers(options: SupplementHandlersOptions): Map<SupplementTaskStage, StageHandler> {
  const handlers = new Map<SupplementTaskStage, StageHandler>();
  handlers.set("download", new DownloadStageHandler({ provider: options.provider, workDir: options.workDir }));
  handlers.set("rename", new RenameLlmStageHandler(options.llm));
  handlers.set(
    "lyrics",
    new LyricsStageHandler({ baseUrl: options.lrclibBaseUrl })
  );
  handlers.set(
    "vocal_remove",
    new VocalRemoveStageHandler({
      bin: options.demucsBin,
      ...(options.demucsArgs ? { binArgs: options.demucsArgs } : {}),
      device: options.demucsDevice,
      model: options.demucsModel,
      workDir: options.workDir
    })
  );
  handlers.set(
    "align",
    new AlignStageHandler({
      bin: options.aligner?.bin ?? "",
      scriptPath: options.aligner?.scriptPath ?? "",
      model: options.aligner?.model ?? "Qwen/Qwen3-ForcedAligner-0.6B",
      device: options.aligner?.device ?? "cuda:0",
      dtype: options.aligner?.dtype ?? "bfloat16",
      demucsModel: options.demucsModel
    })
  );
  handlers.set(
    "mix",
    new MixStageHandler({
      ...(options.ffmpegBin ? { ffmpegBin: options.ffmpegBin } : {}),
      model: options.demucsModel,
      workDir: options.workDir
    })
  );
  handlers.set(
    "index",
    new IndexStageHandler({
      db: options.db,
      workDir: options.workDir,
      ...(options.pathMappings ? { pathMappings: options.pathMappings } : {})
    })
  );
  return handlers;
}
