import { useQuery } from "@tanstack/react-query";
import { fetchAdminDashboard } from "../api/client.js";

export function useAdminDashboard() {
  return useQuery({
    queryKey: ["admin-dashboard"],
    queryFn: fetchAdminDashboard,
    staleTime: 30_000,
    refetchInterval: 60_000
  });
}
