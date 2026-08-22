/**
 * Typed wrappers over `/api/v1/notifications/*` (M11 —
 * `apps/server/src/modules/notifications/notifications.routes.ts`).
 * Mirrors `maintenance-api.ts`'s shape.
 */
import {
  NotificationListResponseSchema,
  OperationAckSchema,
  type NotificationListResponse,
} from '@dwg/shared';
import { request } from './api-client';

export async function fetchNotifications(): Promise<NotificationListResponse> {
  return request('/api/v1/notifications', NotificationListResponseSchema, { method: 'GET' });
}

export async function markNotificationRead(id: string): Promise<void> {
  await request(`/api/v1/notifications/${encodeURIComponent(id)}/read`, OperationAckSchema, {
    method: 'POST',
  });
}

export async function markAllNotificationsRead(): Promise<void> {
  await request('/api/v1/notifications/read-all', OperationAckSchema, { method: 'POST' });
}
