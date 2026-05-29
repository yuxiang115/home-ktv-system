import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { KtvIndexDiagnosticsResponse } from "@home-ktv/domain";
import { fetchKtvIndexDiagnostics } from "../api/client.js";

interface UseSongCatalogRuntimeResult {
  ktvIndexQuery: string;
  setKtvIndexQuery(query: string): void;
  ktvIndexDiagnostics: KtvIndexDiagnosticsResponse | null;
  ktvIndexIsLoading: boolean;
  ktvIndexIsError: boolean;
  refreshKtvIndexDiagnostics(): Promise<void>;
}

export function useSongCatalogRuntime(): UseSongCatalogRuntimeResult {
  const queryClient = useQueryClient();
  const [ktvIndexQuery, setKtvIndexQuery] = useState("");
  const debouncedKtvIndexQuery = useDebouncedValue(ktvIndexQuery, 250);

  const ktvIndexDiagnosticsQueryKey = ["ktv-index-diagnostics", debouncedKtvIndexQuery] as const;
  const ktvIndexDiagnosticsQuery = useQuery({
    queryKey: ktvIndexDiagnosticsQueryKey,
    queryFn: () =>
      fetchKtvIndexDiagnostics({
        query: debouncedKtvIndexQuery,
        sampleSize: 12,
        sampleTimeoutMs: 250
      }),
    retry: false
  });

  return {
    ktvIndexQuery,
    setKtvIndexQuery,
    ktvIndexDiagnostics: ktvIndexDiagnosticsQuery.data ?? null,
    ktvIndexIsLoading: ktvIndexDiagnosticsQuery.isLoading,
    ktvIndexIsError: ktvIndexDiagnosticsQuery.isError,
    async refreshKtvIndexDiagnostics() {
      await queryClient.invalidateQueries({ queryKey: ktvIndexDiagnosticsQueryKey, exact: true });
    }
  };
}

function useDebouncedValue(value: string, delayMs: number): string {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedValue(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);

  return debouncedValue;
}
