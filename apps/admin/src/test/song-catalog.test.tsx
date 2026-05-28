import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { KtvIndexDiagnosticsResponse } from "@home-ktv/domain";
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
  it("opens directly on NAS library diagnostics without mounting retired import or catalog workspaces", async () => {
    const { requests } = installFetchMock();
    render(<App />);

    expect(await screen.findByRole("heading", { name: "NAS 曲库" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "NAS 曲库" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "导入" })).toBeNull();
    expect(screen.queryByText("正式歌曲")).toBeNull();

    await waitFor(() => expect(requests.some((request) => request.url.startsWith("/admin/ktv-index/diagnostics"))).toBe(true));
    expect(requests.some((request) => request.url.startsWith("/admin/catalog/"))).toBe(false);
    expect(requests.some((request) => request.url.startsWith("/admin/import"))).toBe(false);
  });

  it("renders NAS diagnostics, sample reads, and preview results", async () => {
    installFetchMock();
    render(<App />);

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
    tables: [{ tableName: "ktv_song_assets", exists: true }],
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
