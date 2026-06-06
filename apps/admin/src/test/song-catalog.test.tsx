import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AdminDashboardResponse, KtvIndexDiagnosticsResponse } from "@home-ktv/domain";
import { App } from "../App.js";
import { useSongCatalogRuntime } from "../songs/use-song-catalog-runtime.js";

type RequestRecord = {
  url: string;
  method: string;
};

const languageStorageKey = "home_ktv_language_v2";

beforeEach(() => {
  try {
    localStorage.removeItem(languageStorageKey);
  } catch {}
});

afterEach(() => {
  cleanup();
  try {
    localStorage.removeItem?.(languageStorageKey);
  } catch {}
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("NAS library admin workspace", () => {
  it("opens on the Admin report dashboard before mounting NAS diagnostics", async () => {
    const { requests } = installFetchMock();
    render(<App />);

    expect(await screen.findByRole("heading", { name: "曲库总览" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "首页" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "NAS 曲库" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "导入" })).toBeNull();
    expect(screen.queryByText("正式歌曲")).toBeNull();

    await waitFor(() => expect(requests.some((request) => request.url === "/admin/ktv-index/dashboard?trendRange=30d")).toBe(true));
    expect(screen.getByText("总歌曲数")).toBeTruthy();
    expect(screen.getByText("31,893")).toBeTruthy();
    expect(screen.getByText("唱榜 Top 10")).toBeTruthy();
    expect(screen.getByText("音频格式")).toBeTruthy();
    expect(screen.getByText("视频格式")).toBeTruthy();
    expect(screen.getByText("视频分辨率")).toBeTruthy();
    expect(screen.queryByText("队列状态")).toBeNull();
    expect(screen.getByRole("button", { name: "7日" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "30天" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "3个月" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "近一年" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "3个月" }));
    await waitFor(() => expect(requests.some((request) => request.url === "/admin/ktv-index/dashboard?trendRange=3m")).toBe(true));
    expect(screen.getAllByText("阿飞").length).toBeGreaterThan(0);
    expect(requests.some((request) => request.url.startsWith("/admin/ktv-index/diagnostics"))).toBe(false);
    expect(requests.some((request) => request.url.startsWith("/admin/catalog/"))).toBe(false);
    expect(requests.some((request) => request.url.startsWith("/admin/import"))).toBe(false);
  });

  it("renders NAS diagnostics, sample reads, and preview results", async () => {
    const user = userEvent.setup();
    installFetchMock();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "NAS 曲库" }));

    const diagnostics = await screen.findByRole("region", { name: "NAS 曲库诊断" });
    expect(within(diagnostics).getByText("探测覆盖率")).toBeTruthy();
    expect(await within(diagnostics).findByText("0.81%")).toBeTruthy();
    expect(within(diagnostics).getByText("音轨分布")).toBeTruthy();
    expect(within(diagnostics).getByText("1 条音轨")).toBeTruthy();
    expect(within(diagnostics).getByText("NAS 抽样读取")).toBeTruthy();
    expect(within(diagnostics).getByText("搜索预览")).toBeTruthy();
    expect(within(diagnostics).getAllByText("未映射").length).toBeGreaterThan(0);
    expect(within(diagnostics).getByText("relative/song.mkv")).toBeTruthy();
    expect(within(diagnostics).getByText("path outside source root")).toBeTruthy();
    expect(within(diagnostics).getByText("周杰伦 - 七里香")).toBeTruthy();
    expect(within(diagnostics).getByText("/mnt/nas/KTV歌曲/周杰伦-七里香.mkv")).toBeTruthy();
  });

  it("refreshes and searches NAS diagnostics through the runtime only", async () => {
    const user = userEvent.setup();
    const { requests } = installFetchMock();

    render(
      <QueryClientProvider client={new QueryClient()}>
        <SongCatalogRuntimeProbe />
      </QueryClientProvider>
    );

    expect(await screen.findByText("未映射")).toBeTruthy();
    const beforeRefresh = requests.filter((request) => request.url.startsWith("/admin/ktv-index/diagnostics")).length;
    await user.click(screen.getByRole("button", { name: "刷新诊断" }));

    await waitFor(() => {
      expect(requests.filter((request) => request.url.startsWith("/admin/ktv-index/diagnostics")).length).toBeGreaterThan(beforeRefresh);
    });

    await user.type(screen.getByLabelText("搜索"), "七里香");

    await waitFor(() => {
      expect(requests.some((request) => request.url === "/admin/ktv-index/diagnostics?q=%E4%B8%83%E9%87%8C%E9%A6%99&sampleSize=12&sampleTimeoutMs=250")).toBe(true);
    });
    expect(requests.some((request) => request.url.startsWith("/admin/catalog/"))).toBe(false);
    expect(requests.some((request) => request.url.startsWith("/admin/import"))).toBe(false);
  });
});

function SongCatalogRuntimeProbe() {
  const runtime = useSongCatalogRuntime();
  const sample = runtime.ktvIndexDiagnostics?.nasSample.results[0] ?? null;
  return (
    <section>
      <label>
        搜索
        <input value={runtime.ktvIndexQuery} onChange={(event) => runtime.setKtvIndexQuery(event.target.value)} />
      </label>
      <button type="button" onClick={() => void runtime.refreshKtvIndexDiagnostics()}>
        刷新诊断
      </button>
      <p>{sample?.status === "unmapped" ? "未映射" : sample?.status}</p>
      <p>{sample?.filePath}</p>
      <p>{sample?.message}</p>
    </section>
  );
}

function installFetchMock() {
  const requests: RequestRecord[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = new URL(String(input), "http://admin.test");
      const method = init?.method ?? "GET";
      const url = `${requestUrl.pathname}${requestUrl.search}`;
      requests.push({ url, method });

      if (method === "GET" && requestUrl.pathname === "/admin/ktv-index/diagnostics") {
        return json(createKtvDiagnostics());
      }

      if (method === "GET" && requestUrl.pathname === "/admin/ktv-index/dashboard") {
        return json(createAdminDashboard());
      }

      return json({ error: "UNHANDLED_TEST_ROUTE" }, 500);
    })
  );

  return { requests };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function createKtvDiagnostics(): KtvIndexDiagnosticsResponse {
  return {
    tables: [{ tableName: "ktv_songs", exists: true }],
    latestRun: {
      id: "run-1",
      sourceRoot: "/mnt/nas/KTV歌曲",
      sshHost: "nas-host",
      status: "completed",
      filesSeen: 2,
      songsUpserted: 1,
      assetsUpserted: 2,
      errorMessage: null,
      startedAt: "2026-05-20T01:00:00.000Z",
      finishedAt: "2026-05-20T01:01:00.000Z"
    },
    sourceRoot: "/mnt/nas/KTV歌曲",
    activeAssetCount: 2,
    missingAssetCount: 0,
    songCount: 1,
    artistCount: 1,
    parseStrategies: [{ parseStrategy: "filename", count: 2 }],
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
      requested: 2,
      checked: 2,
      readable: 1,
      missing: 0,
      unreadable: 0,
      timeout: 0,
      unmapped: 1,
      results: [
        {
          indexedAssetId: "ktv-unmapped-asset",
          filePath: "relative/song.mkv",
          readable: false,
          status: "unmapped",
          message: "path outside source root"
        }
      ]
    },
    preview: [
      {
        indexedSongId: "ktv-song-1",
        title: "七里香",
        artistName: "周杰伦",
        category: "流行",
        sourceLabel: "NAS索引",
        matchReason: "title",
        versions: [
          {
            indexedAssetId: "ktv-asset-1",
            displayName: "周杰伦-七里香.mkv",
            sourceLabel: "NAS索引",
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

function createAdminDashboard(): AdminDashboardResponse {
  return {
    generatedAt: "2026-06-06T08:00:00.000Z",
    metrics: [
      { id: "songs", label: "总歌曲数", value: 31893, unit: "首", trendLabel: null },
      { id: "artists", label: "歌手数", value: 8568, unit: "位", trendLabel: null },
      { id: "storage", label: "总存储", value: 9876543210, unit: "bytes", trendLabel: null },
      { id: "requests", label: "累计点歌", value: 240, unit: "次", trendLabel: "近 30 天 19 次" }
    ],
    health: {
      latestRun: null,
      sourceRoot: "/mnt/nas/KTV歌曲",
      probeCoveragePercent: 0.81,
      lowConfidenceCount: 3,
      missingAssetCount: 2
    },
    storage: {
      totalBytes: 9876543210,
      sizeBuckets: [
        { label: "50MB 以下", value: 8 },
        { label: "50-100MB", value: 120 },
        { label: "100-200MB", value: 60 },
        { label: "200-300MB", value: 30 },
        { label: "300-500MB", value: 12 },
        { label: "500MB 以上", value: 4 }
      ],
      extensionDistribution: [{ label: ".mkv", value: 300 }],
      largestSongs: [
        {
          songId: "ktv-largest-1",
          title: "最长的电影",
          artistName: "周杰伦",
          fileName: "周杰伦-最长的电影.mkv",
          extension: ".mkv",
          sizeBytes: 1999000000
        }
      ]
    },
    catalog: {
      topArtists: [{ label: "周杰伦", value: 120 }],
      topStyles: [{ label: "流行", value: 600 }],
      parseStrategies: [{ label: "filename", value: 34385 }],
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
      statusDistribution: [{ label: "played", value: 180 }],
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
