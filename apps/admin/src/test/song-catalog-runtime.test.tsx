import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KtvIndexDiagnosticsResponse } from "@home-ktv/domain";
import { useSongCatalogRuntime } from "../songs/use-song-catalog-runtime.js";

type RequestRecord = {
  url: string;
  method: string;
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useSongCatalogRuntime", () => {
  it("loads and refreshes NAS library diagnostics without formal catalog requests", async () => {
    const { requests } = installFetchMock();
    const { result } = renderHook(() => useSongCatalogRuntime(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.ktvIndexDiagnostics?.songCount).toBe(1));
    expect(requests.some((request) => request.method === "GET" && request.url === "/admin/ktv-index/diagnostics?sampleSize=0&sampleTimeoutMs=250")).toBe(true);

    const beforeRefresh = requests.length;
    await act(async () => {
      await result.current.refreshKtvIndexDiagnostics();
    });

    await waitFor(() => expect(requests.length).toBeGreaterThan(beforeRefresh));
    expect(requests.some((request) => request.url.startsWith("/admin/catalog/"))).toBe(false);
    expect(requests.some((request) => request.url.startsWith("/admin/import"))).toBe(false);
  });

  it("passes the debounced preview query to NAS diagnostics", async () => {
    const { requests } = installFetchMock();
    const { result } = renderHook(() => useSongCatalogRuntime(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.ktvIndexDiagnostics?.songCount).toBe(1));

    await act(async () => {
      result.current.setKtvIndexQuery("七里香");
    });

    await waitFor(() => {
      expect(requests.some((request) => request.url === "/admin/ktv-index/diagnostics?q=%E4%B8%83%E9%87%8C%E9%A6%99&sampleSize=0&sampleTimeoutMs=250")).toBe(true);
    });
  });
});

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });

  return function TestQueryClientProvider({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
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
    tables: [{ tableName: "ktv_songs", exists: true }],
    latestRun: null,
    sourceRoot: "/mnt/nas/KTV歌曲",
    activeAssetCount: 2,
    missingAssetCount: 0,
    songCount: 1,
    artistCount: 1,
    parseStrategies: [],
    technicalStatusCounts: [],
    audioTrackDistribution: [],
    probePendingCount: 0,
    probeFailedCount: 0,
    probeCoveragePercent: 100,
    lowConfidenceCount: 0,
    minParseConfidence: null,
    nasSample: {
      requested: 0,
      checked: 0,
      readable: 0,
      missing: 0,
      unreadable: 0,
      timeout: 0,
      unmapped: 0,
      results: []
    },
    preview: []
  };
}
