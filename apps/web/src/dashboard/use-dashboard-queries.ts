/**
 * TanStack Query hook over `lib/dashboard-api.ts`. Polled rather than
 * pushed: ARCHITECTURE.md §8 reserves SSE for genuinely event-driven
 * sources (container state, log tailing, job progress) and explicitly
 * allows polling "where it is genuinely sufficient (slow-moving lists)".
 * The dashboard's own data is not push-driven at its source either — every
 * `DashboardService` collector (`dashboard.service.ts`) is a live,
 * request-time read, not a subscription to a change feed — so a 30s
 * refetch is a proportionate default, not a placeholder for a real-time
 * stream this milestone deferred building.
 */
import { useQuery } from '@tanstack/react-query';
import { fetchDashboard } from '@/lib/dashboard-api';

export const dashboardKey = ['dashboard'] as const;

const REFETCH_INTERVAL_MS = 30_000;

export function useDashboardQuery() {
  return useQuery({
    queryKey: dashboardKey,
    queryFn: fetchDashboard,
    refetchInterval: REFETCH_INTERVAL_MS,
  });
}
