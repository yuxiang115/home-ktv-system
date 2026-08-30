import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OnlineSupplementTask } from "@home-ktv/domain";
import { fetchBestLrclibWithVariants } from "../lrclib-client.js";
import type { StageExecuteInput, StageExecuteResult, StageHandler } from "../supplement-orchestrator.js";

const LYRICS_SUBDIR = "_lyrics";

export interface LyricsStageHandlerOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class LyricsStageHandler implements StageHandler {
  readonly stage = "lyrics" as const;

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly timeoutMs: number | undefined;

  constructor(options: LyricsStageHandlerOptions) {
    this.baseUrl = options.baseUrl;
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs;
  }

  async execute(input: StageExecuteInput): Promise<StageExecuteResult> {
    const names = supplementSearchNames(input.task);
    if (!names.artistName || !names.trackName) {
      return { status: "completed", message: "lyrics skipped (no usable artist/title)" };
    }

    let synced: string | null = null;
    try {
      const request: Parameters<typeof fetchBestLrclibWithVariants>[0] = {
        artistName: names.artistName,
        trackName: names.trackName,
        durationMs: input.task.durationMs,
        baseUrl: this.baseUrl
      };
      if (this.fetchImpl) {
        request.fetchImpl = this.fetchImpl;
      }
      if (this.timeoutMs !== undefined) {
        request.timeoutMs = this.timeoutMs;
      }
      input.log("lyrics lookup", { artistName: names.artistName, trackName: names.trackName });
      const matched = await fetchBestLrclibWithVariants(request);
      if (matched) {
        synced = matched.record.syncedLyrics?.trim() || null;
        input.log("lyrics matched", { variant: matched.variant });
      }
    } catch (error) {
      input.log("lyrics lookup error", {
        error: error instanceof Error ? error.message : String(error)
      });
      return {
        status: "completed",
        message: `lyrics skipped (lrclib error: ${error instanceof Error ? error.message : String(error)})`
      };
    }

    if (!synced) {
      input.log("lyrics not found", { artistName: names.artistName, trackName: names.trackName });
      return { status: "completed", message: "lyrics not found (skipped)" };
    }

    const dir = path.join(input.workDir, LYRICS_SUBDIR);
    await mkdir(dir, { recursive: true });
    const lyricFile = path.join(dir, `${input.task.id}.lrc`);
    await writeFile(lyricFile, `${synced}\n`, "utf8");
    input.log("lyrics written", { lyricFile, bytes: synced.length });
    await input.reportProgress(95, "lyrics fetched");

    return { status: "completed", message: "lyrics fetched", lyricFile };
  }
}

export function supplementSearchNames(
  task: OnlineSupplementTask
): { artistName: string | null; trackName: string | null } {
  const spec = task.llmRenamedTitle?.trim();
  if (spec) {
    const parts = spec.split("-").map((part) => part.trim()).filter(Boolean);
    if (parts.length >= 2) {
      return {
        artistName: underscoreToSpace(parts[0] ?? ""),
        trackName: underscoreToSpace(parts[1] ?? "")
      };
    }
  }

  return {
    artistName: task.artistName.trim() || null,
    trackName: task.title.trim() || null
  };
}

function underscoreToSpace(value: string): string {
  return value.replaceAll("_", " ").trim();
}
