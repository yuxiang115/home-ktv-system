import { describe, expect, it } from "vitest";
import type { MediaInfoProvenance, MediaInfoSummary } from "@home-ktv/domain";
import type { QueryExecutor } from "../db/query-executor.js";
import {
  KtvIndexTechnicalProbeService,
  type KtvIndexProbeTargetRow
} from "../modules/ktv-index/ktv-index-technical-probe.js";

describe("KtvIndexTechnicalProbeService", () => {
  it("probes active unprobed assets, maps NAS paths, and writes compact media metadata", async () => {
    const db = new FakeKtvIndexProbeDb({
      rows: [
        createProbeTarget({ id: "asset-1", file_path: "/mnt/nas/KTV歌曲/a.mkv" }),
        createProbeTarget({ id: "asset-2", file_path: "/mnt/nas/KTV歌曲/b.mpg" }),
        createProbeTarget({ id: "asset-3", file_path: "/mnt/nas/KTV歌曲/c.mkv" })
      ]
    });
    const accessedPaths: string[] = [];
    const probedPaths: string[] = [];
    const service = new KtvIndexTechnicalProbeService(db, {
      accessFile: async (filePath) => {
        accessedPaths.push(filePath);
      },
      pathMappings: [{ from: "/mnt/nas/KTV歌曲", to: "/nas/KTV歌曲" }],
      probeMedia: async (filePath) => {
        probedPaths.push(filePath);
        return createProbeSummary({ filePath, audioTrackCount: filePath.includes("b.mpg") ? 1 : 2 });
      }
    });

    const result = await service.probeKtvIndexAssets({ limit: 2, concurrency: 2 });

    expect(result).toMatchObject({
      selected: 2,
      probed: 2,
      failed: 0,
      skipped: 0,
      singleTrack: 1,
      dualTrack: 1,
      multiTrack: 0
    });
    expect(accessedPaths).toEqual(["/nas/KTV歌曲/a.mkv", "/nas/KTV歌曲/b.mpg"]);
    expect(probedPaths).toEqual(["/nas/KTV歌曲/a.mkv", "/nas/KTV歌曲/b.mpg"]);
    expect(db.successes).toHaveLength(2);
    expect(db.successes[0]).toMatchObject({
      assetId: "asset-1",
      technicalMetadata: {
        mediaInfoSummary: expect.objectContaining({
          audioTracks: [
            expect.objectContaining({ id: "stream-0" }),
            expect.objectContaining({ id: "stream-1" })
          ]
        }),
        mediaInfoProvenance: expect.objectContaining({
          source: "ffprobe",
          importedFrom: "/nas/KTV歌曲/a.mkv"
        })
      }
    });
    expect(JSON.stringify(db.successes[0]?.technicalMetadata)).not.toContain("\"raw\"");
    expect(db.failures).toHaveLength(0);
    expect(db.selectValues[0]).toMatchObject({ limit: 2, retryFailed: false });
  });

  it("stores compact probe errors and keeps failed assets retryable when requested", async () => {
    const db = new FakeKtvIndexProbeDb({
      rows: [
        createProbeTarget({
          id: "asset-failed-before",
          file_path: "/mnt/nas/KTV歌曲/retry.mkv",
          technical_status: "failed"
        })
      ]
    });
    const service = new KtvIndexTechnicalProbeService(db, {
      accessFile: async () => {},
      pathMappings: [{ from: "/mnt/nas/KTV歌曲", to: "/nas/KTV歌曲" }],
      probeMedia: async () => {
        throw Object.assign(new Error("ffprobe timeout"), { code: "ETIMEDOUT" });
      }
    });

    const result = await service.probeKtvIndexAssets({ retryFailed: true, concurrency: 1 });

    expect(result).toMatchObject({
      selected: 1,
      probed: 0,
      failed: 1,
      skipped: 0
    });
    expect(db.selectValues[0]).toMatchObject({ retryFailed: true });
    expect(db.failures).toEqual([
      {
        assetId: "asset-failed-before",
        technicalMetadata: {
          probeError: {
            code: "ETIMEDOUT",
            message: "ffprobe timeout",
            failedAt: expect.any(String)
          }
        }
      }
    ]);
    expect(JSON.stringify(db.failures[0]?.technicalMetadata)).not.toContain("\"raw\"");
  });

  it("does not probe or write rows in dry-run mode", async () => {
    const db = new FakeKtvIndexProbeDb({
      rows: [
        createProbeTarget({ id: "asset-1" }),
        createProbeTarget({ id: "asset-2" })
      ]
    });
    const service = new KtvIndexTechnicalProbeService(db, {
      accessFile: async () => {
        throw new Error("accessFile should not run during dry-run");
      },
      probeMedia: async () => {
        throw new Error("probeMedia should not run during dry-run");
      }
    });

    const result = await service.probeKtvIndexAssets({ dryRun: true, limit: 10 });

    expect(result).toMatchObject({
      selected: 2,
      probed: 0,
      failed: 0,
      skipped: 2
    });
    expect(db.successes).toHaveLength(0);
    expect(db.failures).toHaveLength(0);
  });

  it("can target one indexed asset id", async () => {
    const db = new FakeKtvIndexProbeDb({
      rows: [createProbeTarget({ id: "asset-only" })]
    });
    const service = new KtvIndexTechnicalProbeService(db, {
      accessFile: async () => {},
      probeMedia: async (filePath) => createProbeSummary({ filePath, audioTrackCount: 3 })
    });

    const result = await service.probeKtvIndexAssets({ assetId: "asset-only" });

    expect(result).toMatchObject({
      selected: 1,
      probed: 1,
      failed: 0,
      multiTrack: 1
    });
    expect(db.selectValues[0]).toMatchObject({ assetId: "asset-only" });
  });

  it("selects all eligible assets when limit is omitted for full-library backfill", async () => {
    const db = new FakeKtvIndexProbeDb({
      rows: Array.from({ length: 120 }, (_, index) => createProbeTarget({ id: `asset-${index}` }))
    });
    const service = new KtvIndexTechnicalProbeService(db, {
      accessFile: async () => {},
      probeMedia: async (filePath) => createProbeSummary({ filePath, audioTrackCount: 2 })
    });

    const result = await service.probeKtvIndexAssets({ concurrency: 4 });

    expect(result.selected).toBe(120);
    expect(result.probed).toBe(120);
    expect(db.selectValues[0]).toMatchObject({ limit: null });
  });
});

interface FakeSelectValues {
  limit: number | null;
  retryFailed: boolean;
  assetId: string | null;
}

class FakeKtvIndexProbeDb implements QueryExecutor {
  readonly successes: Array<{ assetId: string; technicalMetadata: Record<string, unknown> }> = [];
  readonly failures: Array<{ assetId: string; technicalMetadata: Record<string, unknown> }> = [];
  readonly selectValues: FakeSelectValues[] = [];

  constructor(private readonly input: { rows: KtvIndexProbeTargetRow[] }) {}

  async query<TRow>(text: string, values: readonly unknown[] = []) {
    if (text.includes("FROM ktv_song_assets")) {
      const [retryFailed, assetId, limit = null] = values as [boolean, string | null, number | null];
      this.selectValues.push({ limit, retryFailed, assetId });
      const rows = this.input.rows
        .filter((row) => (assetId ? row.id === assetId : true))
        .filter((row) => retryFailed || row.technical_status !== "failed");
      const selectedRows = limit == null ? rows : rows.slice(0, limit);
      return { rows: selectedRows as TRow[] };
    }

    if (text.includes("technical_status = 'probed'")) {
      this.successes.push({
        assetId: String(values[1]),
        technicalMetadata: parseJsonbParam(values[0])
      });
      return { rows: [] as TRow[] };
    }

    if (text.includes("technical_status = 'failed'")) {
      this.failures.push({
        assetId: String(values[1]),
        technicalMetadata: parseJsonbParam(values[0])
      });
      return { rows: [] as TRow[] };
    }

    return { rows: [] as TRow[] };
  }
}

function createProbeTarget(input: Partial<KtvIndexProbeTargetRow> = {}): KtvIndexProbeTargetRow {
  return {
    id: "asset-1",
    file_path: "/mnt/nas/KTV歌曲/demo.mkv",
    technical_status: "pending",
    ...input
  };
}

function createProbeSummary(input: { filePath: string; audioTrackCount: number }) {
  const mediaInfoSummary: MediaInfoSummary = {
    container: input.filePath.endsWith(".mpg") ? "mpeg" : "matroska,webm",
    durationMs: 180000,
    videoCodec: "mpeg2video",
    resolution: { width: 720, height: 480 },
    fileSizeBytes: 123456,
    audioTracks: Array.from({ length: input.audioTrackCount }, (_, index) => ({
      index,
      id: `stream-${index}`,
      label: `Audio ${index + 1}`,
      language: null,
      codec: "mp2",
      channels: 2
    }))
  };
  const mediaInfoProvenance: MediaInfoProvenance = {
    source: "ffprobe",
    sourceVersion: null,
    probedAt: "2026-05-27T03:00:00.000Z",
    importedFrom: input.filePath
  };

  return {
    durationMs: mediaInfoSummary.durationMs,
    formatName: mediaInfoSummary.container,
    videoCodec: mediaInfoSummary.videoCodec,
    audioCodec: "mp2",
    width: mediaInfoSummary.resolution?.width ?? null,
    height: mediaInfoSummary.resolution?.height ?? null,
    mediaInfoSummary,
    mediaInfoProvenance,
    raw: { shouldNotPersist: true }
  };
}

function parseJsonbParam(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") {
    throw new Error("expected serialized jsonb");
  }
  return JSON.parse(value) as Record<string, unknown>;
}
