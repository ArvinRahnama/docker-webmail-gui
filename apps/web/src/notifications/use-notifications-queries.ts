/**
 * TanStack Query hooks over `lib/notifications-api.ts`. Polled, same
 * reasoning as `dashboard/use-dashboard-queries.ts` — the notifications
 * evaluator itself only re-derives state every few minutes server-side
 * (`notifications-evaluator.ts`'s own interval), so a faster client poll
 * would not observe anything fresher; 60s keeps the topbar bell
 * reasonably current without it.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '@/lib/notifications-api';

export const notificationsKey = ['notifications'] as const;

const REFETCH_INTERVAL_MS = 60_000;

export function useNotificationsQuery() {
  return useQuery({
    queryKey: notificationsKey,
    queryFn: fetchNotifications,
    refetchInterval: REFETCH_INTERVAL_MS,
  });
}

export function useMarkNotificationReadMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => markNotificationRead(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: notificationsKey });
    },
  });
}

export function useMarkAllNotificationsReadMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => markAllNotificationsRead(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: notificationsKey });
    },
  });
}
