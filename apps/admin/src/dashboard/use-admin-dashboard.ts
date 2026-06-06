import { useQuery } from "@tanstack/react-query";
import type { AdminDashboardTrendRange } from "@home-ktv/domain";
import { fetchAdminDashboard } from "../api/client.js";

export function useAdminDashboard(trendRange: AdminDashboardTrendRange = "30d") {
  return useQuery({
    queryKey: ["admin-dashboard", trendRange],
    queryFn: () => fetchAdminDashboard({ trendRange }),
    staleTime: 30_000,
    refetchInterval: 60_000
  });
}
