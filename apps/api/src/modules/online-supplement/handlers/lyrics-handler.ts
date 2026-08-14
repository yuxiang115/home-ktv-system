import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OnlineSupplementTask } from "@home-ktv/domain";
import type { StageExecuteInput, StageExecuteResult, StageHandler } from "../supplement-orchestrator.js";

const LYRICS_SUBDIR = "_lyrics";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface LyricsStageHandlerOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface LrclibRecord {
  syncedLyrics?: string | null;
  instrumental?: boolean;
}

export class LyricsStageHandler implements StageHandler {
  readonly stage = "lyrics" as const;

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: LyricsStageHandlerOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async execute(input: StageExecuteInput): Promise<StageExecuteResult> {
    const names = supplementSearchNames(input.task);
    if (!names.artistName || !names.trackName) {
      return { status: "completed", message: "lyrics skipped (no usable artist/title)" };
    }

    let record: LrclibRecord | null = null;
    try {
      record = await this.fetchBestRecord(names.artistName, names.trackName, input.task.durationMs);
    } catch (error) {
      return {
        status: "completed",
        message: `lyrics skipped (lrclib error: ${error instanceof Error ? error.message : String(error)})`
      };
    }

    const synced = record?.syncedLyrics?.trim();
    if (!synced) {
      return { status: "completed", message: "lyrics not found (skipped)" };
    }

    const dir = path.join(input.workDir, LYRICS_SUBDIR);
    await mkdir(dir, { recursive: true });
    const lyricFile = path.join(dir, `${input.task.id}.lrc`);
    await writeFile(lyricFile, `${synced}\n`, "utf8");
    await input.reportProgress(95, "lyrics fetched");

    return { status: "completed", message: "lyrics fetched", lyricFile };
  }

  private async fetchBestRecord(
    artistName: string,
    trackName: string,
    durationMs: number | null
  ): Promise<LrclibRecord | null> {
    const durationSeconds =
      durationMs !== null && durationMs > 0 ? Math.round(durationMs / 1000) : null;

    if (durationSeconds !== null) {
      const exact = await this.get("/api/get", artistName, trackName, durationSeconds);
      if (exact) {
        return exact;
      }
    }

    const noDuration = await this.get("/api/get", artistName, trackName, null);
    if (noDuration) {
      return noDuration;
    }

    const searchUrl = new URL(`${this.baseUrl}/api/search`);
    searchUrl.searchParams.set("artist_name", artistName);
    searchUrl.searchParams.set("track_name", trackName);
    const response = await this.fetchImpl(searchUrl, {
      headers: { "Lrclib-Client": "home-ktv-system" },
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) {
      return null;
    }
    const results = (await response.json()) as LrclibRecord[];
    if (!Array.isArray(results)) {
      return null;
    }
    return results.find((item) => !item.instrumental && item.syncedLyrics?.trim()) ?? null;
  }

  private async get(
    endpoint: string,
    artistName: string,
    trackName: string,
    durationSeconds: number | null
  ): Promise<LrclibRecord | null> {
    const url = new URL(`${this.baseUrl}${endpoint}`);
    url.searchParams.set("artist_name", artistName);
    url.searchParams.set("track_name", trackName);
    if (durationSeconds !== null) {
      url.searchParams.set("duration", String(durationSeconds));
    }
    const response = await this.fetchImpl(url, {
      headers: { "Lrclib-Client": "home-ktv-system" },
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (response.status === 404 || !response.ok) {
      return null;
    }
    return (await response.json()) as LrclibRecord;
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
