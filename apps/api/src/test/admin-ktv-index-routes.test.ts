import Fastify from "fastify";
import type { AdminDashboardResponse, KtvIndexDiagnosticsResponse } from "@home-ktv/domain";
import { describe, expect, it, vi } from "vitest";
import { registerAdminKtvIndexRoutes } from "../routes/admin-ktv-index.js";

describe("admin KTV index routes", () => {
  it("returns bounded raw diagnostics for the requested preview query", async () => {
    const ktvIndex = {
      searchIndexedSongs: vi.fn(async () => []),
      getDiagnostics: vi.fn(async () => createDiagnosticsFixture()),
      getAdminDashboard: vi.fn(async () => createDashboardFixture())
    };
    const server = Fastify();
    await registerAdminKtvIndexRoutes(server, { ktvIndex });

    const response = await server.inject({
      method: "GET",
      url: "/admin/ktv-index/diagnostics?q=%E4%B8%83%E9%87%8C%E9%A6%99&sampleSize=999&sampleTimeoutMs=2"
    });

    expect(response.statusCode).toBe(200);
    expect(ktvIndex.getDiagnostics).toHaveBeenCalledWith({
      previewQuery: "七里香",
      previewLimit: 8,
      sampleSize: 50,
      sampleTimeoutMs: 50
    });
    expect(response.json()).toMatchObject({
      tables: [{ tableName: "ktv_songs", exists: true }],
      latestRun: { id: "run-1", sourceRoot: "/mnt/nas/KTV歌曲" },
      activeAssetCount: 34385,
      nasSample: { checked: 1, readable: 1 },
      preview: [
        {
          indexedSongId: "ktv-song-1",
          title: "七里香",
          versions: [
            {
              indexedAssetId: "ktv-asset-1",
              filePath: "/mnt/nas/KTV歌曲/周杰伦-七里香.mkv"
            }
          ]
        }
      ]
    });
  });

  it("returns the Admin dashboard report from the indexed catalog repository", async () => {
    const ktvIndex = {
      searchIndexedSongs: vi.fn(async () => []),
      getDiagnostics: vi.fn(async () => createDiagnosticsFixture()),
      getAdminDashboard: vi.fn(async () => createDashboardFixture())
    };
    const server = Fastify();
    await registerAdminKtvIndexRoutes(server, { ktvIndex });

    const response = await server.inject({
      method: "GET",
      url: "/admin/ktv-index/dashboard?trendRange=3m"
    });

    expect(response.statusCode).toBe(200);
    expect(ktvIndex.getAdminDashboard).toHaveBeenCalledWith({ trendRange: "3m" });
    const body = response.json();
    expect(body).toMatchObject({
      generatedAt: "2026-06-06T08:00:00.000Z",
      requests: {
        totalQueueEntries: 240,
        topSongs: [{ title: "七里香", requestCount: 32 }],
        topRequesters: [{ displayName: "阿飞", requestCount: 55 }]
      }
    });
    expect(body.metrics).toEqual(expect.arrayContaining([expect.objectContaining({ id: "songs", label: "总歌曲数", value: 31893 })]));
  });
});

function createDiagnosticsFixture(): KtvIndexDiagnosticsResponse {
  return {
    tables: [{ tableName: "ktv_songs", exists: true }],
    latestRun: {
      id: "run-1",
      sourceRoot: "/mnt/nas/KTV歌曲",
      sshHost: "nas-host",
      status: "completed",
      filesSeen: 34385,
      songsUpserted: 31893,
      assetsUpserted: 34385,
      errorMessage: null,
      startedAt: "2026-05-20T01:00:00.000Z",
      finishedAt: "2026-05-20T01:10:00.000Z"
    },
    sourceRoot: "/mnt/nas/KTV歌曲",
    activeAssetCount: 34385,
    missingAssetCount: 28,
    songCount: 31893,
    artistCount: 8568,
    parseStrategies: [{ parseStrategy: "filename", count: 34385 }],
    technicalStatusCounts: [
      { technicalStatus: "failed", count: 2 },
      { technicalStatus: "pending", count: 100 },
      { technicalStatus: "probed", count: 280 }
    ],
    audioTrackDistribution: [
      { audioTrackCount: 1, count: 12 },
      { audioTrackCount: 2, count: 260 }
    ],
    probePendingCount: 100,
    probeFailedCount: 2,
    probeCoveragePercent: 0.81,
    lowConfidenceCount: 0,
    minParseConfidence: 0.98,
    nasSample: {
      requested: 1,
      checked: 1,
      readable: 1,
      missing: 0,
      unreadable: 0,
      timeout: 0,
      unmapped: 0,
      results: [
        {
          indexedAssetId: "ktv-asset-1",
          filePath: "/mnt/nas/KTV歌曲/周杰伦-七里香.mkv",
          readable: true,
          status: "readable",
          message: null
        }
      ]
    },
    preview: [
      {
        indexedSongId: "ktv-song-1",
        title: "七里香",
        artistName: "周杰伦",
        category: "流行",
        sourceLabel: "KTV索引",
        matchReason: "title",
        versions: [
          {
            indexedAssetId: "ktv-asset-1",
            displayName: "周杰伦-七里香.mkv",
            sourceLabel: "KTV索引",
            extension: ".mkv",
            sizeBytes: 123456,
            category: "流行",
            parseConfidence: 0.98,
            filePath: "/mnt/nas/KTV歌曲/周杰伦-七里香.mkv",
            missingAt: null
          }
        ]
      }
    ]
  };
}

function createDashboardFixture(): AdminDashboardResponse {
  return {
    generatedAt: "2026-06-06T08:00:00.000Z",
    metrics: [
      { id: "songs", label: "总歌曲数", value: 31893, unit: "首", trendLabel: null },
      { id: "storage", label: "总存储", value: 987654321, unit: "bytes", trendLabel: null }
    ],
    health: {
      latestRun: null,
      sourceRoot: "/mnt/nas/KTV歌曲",
      probeCoveragePercent: 81.5,
      lowConfidenceCount: 3,
      missingAssetCount: 2
    },
    storage: {
      totalBytes: 987654321,
      sizeBuckets: [{ label: "50-100MB", value: 120 }],
      extensionDistribution: [{ label: ".mkv", value: 300 }],
      largestSongs: [
        {
          songId: "ktv-song-1",
          title: "七里香",
          artistName: "周杰伦",
          fileName: "周杰伦-七里香.mkv",
          extension: ".mkv",
          sizeBytes: 987654321
        }
      ]
    },
    catalog: {
      topArtists: [{ label: "周杰伦", value: 120 }],
      topStyles: [{ label: "流行", value: 600 }],
      parseStrategies: [{ label: "filename", value: 31893 }],
      technicalStatus: [{ label: "probed", value: 280 }],
      audioTrackDistribution: [{ label: "2 条音轨", value: 260 }],
      audioCodecDistribution: [{ label: "aac", value: 520 }],
      videoCodecDistribution: [{ label: "h264", value: 260 }],
      videoResolutionDistribution: [{ label: "1920x1080", value: 180 }]
    },
    requests: {
      totalQueueEntries: 240,
      totalSongRequests: 340,
      requestTrend: [{ date: "2026-06-06", requestCount: 12, uniqueRequesterCount: 3 }],
      topSongs: [
        {
          songId: "ktv-song-1",
          title: "七里香",
          artistName: "周杰伦",
          requestCount: 32,
          lastRequestedAt: "2026-06-06T07:30:00.000Z"
        }
      ],
      topArtists: [{ label: "周杰伦", value: 80 }],
      topRequesters: [
        {
          requesterId: "13800000000",
          displayName: "阿飞",
          requestCount: 55,
          uniqueSongCount: 30,
          lastRequestedAt: "2026-06-06T07:30:00.000Z"
        }
      ],
      recentRequests: [
        {
          queueEntryId: "queue-1",
          songId: "ktv-song-1",
          title: "七里香",
          artistName: "周杰伦",
          requesterName: "阿飞",
          requestedAt: "2026-06-06T07:30:00.000Z",
          status: "played"
        }
      ]
    }
  };
}
