import Fastify from "fastify";
import type { KtvIndexDiagnosticsResponse } from "@home-ktv/domain";
import { describe, expect, it, vi } from "vitest";
import { registerAdminKtvIndexRoutes } from "../routes/admin-ktv-index.js";

describe("admin KTV index routes", () => {
  it("returns bounded raw diagnostics for the requested preview query", async () => {
    const ktvIndex = {
      searchIndexedSongs: vi.fn(async () => []),
      getDiagnostics: vi.fn(async () => createDiagnosticsFixture())
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
      tables: [{ tableName: "ktv_song_assets", exists: true }],
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
});

function createDiagnosticsFixture(): KtvIndexDiagnosticsResponse {
  return {
    tables: [{ tableName: "ktv_song_assets", exists: true }],
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
