import { access } from "node:fs/promises";
import { constants } from "node:fs";
import type { MediaInfoProvenance, MediaInfoSummary } from "@home-ktv/domain";
import type { QueryExecutor } from "../../db/query-executor.js";
import { mapMediaPath, type MediaPathMapping } from "../assets/media-path-mapping.js";
import { probeMediaFile, type MediaProbeSummary } from "../ingest/media-probe.js";

export interface KtvIndexProbeTargetRow {
  id: string;
  file_path: string;
  technical_status: "pending" | "probed" | "failed";
}

export interface ProbeKtvIndexAssetsInput {
  limit?: number | undefined;
  concurrency?: number | undefined;
  retryFailed?: boolean | undefined;
  dryRun?: boolean | undefined;
  assetId?: string | undefined;
}

export interface KtvIndexTechnicalProbeResult {
  selected: number;
  probed: number;
  failed: number;
  skipped: number;
  singleTrack: number;
  dualTrack: number;
  multiTrack: number;
  elapsedMs: number;
}

export interface KtvIndexTechnicalProbeServiceOptions {
  accessFile?: (filePath: string) => Promise<void>;
  pathMappings?: readonly MediaPathMapping[];
  probeMedia?: (filePath: string) => Promise<MediaProbeSummary>;
  now?: () => Date;
}

export class KtvIndexTechnicalProbeService {
  constructor(
    private readonly db: QueryExecutor,
    private readonly options: KtvIndexTechnicalProbeServiceOptions = {}
  ) {}

  async probeKtvIndexAssets(input: ProbeKtvIndexAssetsInput = {}): Promise<KtvIndexTechnicalProbeResult> {
    const startedAt = Date.now();
    const targets = await this.selectProbeTargets(input);
    const result: KtvIndexTechnicalProbeResult = {
      selected: targets.length,
      probed: 0,
      failed: 0,
      skipped: input.dryRun ? targets.length : 0,
      singleTrack: 0,
      dualTrack: 0,
      multiTrack: 0,
      elapsedMs: 0
    };

    if (input.dryRun || targets.length === 0) {
      result.elapsedMs = Date.now() - startedAt;
      return result;
    }

    const concurrency = normalizeConcurrency(input.concurrency);
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
      while (nextIndex < targets.length) {
        const target = targets[nextIndex++];
        if (target) {
          await this.probeOne(target, result);
        }
      }
    });
    await Promise.all(workers);

    result.elapsedMs = Date.now() - startedAt;
    return result;
  }

  async selectProbeTargets(input: ProbeKtvIndexAssetsInput = {}): Promise<KtvIndexProbeTargetRow[]> {
    const limit = normalizeLimit(input.limit);
    const retryFailed = input.retryFailed === true;
    const assetId = clean(input.assetId) || null;
    const values = [retryFailed, assetId] as unknown[];
    const limitClause = limit == null ? "" : "LIMIT $3";
    if (limit != null) {
      values.push(limit);
    }

    const result = await this.db.query<KtvIndexProbeTargetRow>(
      `SELECT id, file_path, technical_status
       FROM ktv_song_assets
       WHERE missing_at IS NULL
         AND ($2::text IS NULL OR id = $2)
         AND ($1::boolean OR technical_status <> 'failed')
         AND (
           technical_status <> 'probed'
           OR jsonb_typeof(coalesce(technical_metadata->'mediaInfoSummary'->'audioTracks', technical_metadata->'audioTracks')) IS DISTINCT FROM 'array'
         )
       ORDER BY updated_at ASC, file_path ASC
       ${limitClause}`,
      values
    );
    return result.rows;
  }

  async markProbeSucceeded(input: {
    assetId: string;
    mediaInfoSummary: MediaInfoSummary;
    mediaInfoProvenance: MediaInfoProvenance;
    probedAt: string;
  }): Promise<void> {
    await this.db.query(
      `UPDATE ktv_song_assets
       SET technical_status = 'probed',
           technical_metadata = technical_metadata || $1::jsonb,
           updated_at = now()
       WHERE id = $2`,
      [
        JSON.stringify({
          mediaInfoSummary: input.mediaInfoSummary,
          mediaInfoProvenance: input.mediaInfoProvenance,
          probedAt: input.probedAt
        }),
        input.assetId
      ]
    );
  }

  async markProbeFailed(input: {
    assetId: string;
    error: unknown;
    failedAt: string;
  }): Promise<void> {
    await this.db.query(
      `UPDATE ktv_song_assets
       SET technical_status = 'failed',
           technical_metadata = technical_metadata || $1::jsonb,
           updated_at = now()
       WHERE id = $2`,
      [
        JSON.stringify({
          probeError: {
            code: errorCode(input.error),
            message: errorMessage(input.error),
            failedAt: input.failedAt
          }
        }),
        input.assetId
      ]
    );
  }

  private async probeOne(target: KtvIndexProbeTargetRow, result: KtvIndexTechnicalProbeResult): Promise<void> {
    const probedAt = this.nowIsoString();
    try {
      const probePath = mapMediaPath(target.file_path, this.options.pathMappings ?? []);
      await (this.options.accessFile ?? defaultAccessFile)(probePath);
      const probeSummary = await (this.options.probeMedia ?? probeMediaFile)(probePath);

      await this.markProbeSucceeded({
        assetId: target.id,
        mediaInfoSummary: probeSummary.mediaInfoSummary,
        mediaInfoProvenance: probeSummary.mediaInfoProvenance,
        probedAt
      });

      result.probed += 1;
      const trackCount = probeSummary.mediaInfoSummary.audioTracks.length;
      if (trackCount === 1) {
        result.singleTrack += 1;
      } else if (trackCount === 2) {
        result.dualTrack += 1;
      } else if (trackCount > 2) {
        result.multiTrack += 1;
      }
    } catch (error) {
      await this.markProbeFailed({
        assetId: target.id,
        error,
        failedAt: probedAt
      });
      result.failed += 1;
    }
  }

  private nowIsoString(): string {
    return (this.options.now ?? (() => new Date()))().toISOString();
  }
}

async function defaultAccessFile(filePath: string): Promise<void> {
  await access(filePath, constants.R_OK);
}

function normalizeLimit(value: number | undefined): number | null {
  if (value == null) {
    return null;
  }
  if (!Number.isInteger(value) || value <= 0) {
    return null;
  }
  return Math.min(10_000, value);
}

function normalizeConcurrency(value: number | undefined): number {
  if (!Number.isInteger(value) || value == null || value <= 0) {
    return 2;
  }
  return Math.min(32, value);
}

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}

function errorCode(error: unknown): string {
  if (isRecord(error) && typeof error.code === "string" && error.code.trim()) {
    return error.code;
  }
  return "PROBE_FAILED";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
