/**
 * Typed wrapper over `GET /api/v1/dashboard` (M11 —
 * `apps/server/src/modules/dashboard/dashboard.routes.ts`). Mirrors
 * `maintenance-api.ts`'s shape.
 */
import { DashboardResponseSchema, type DashboardResponse } from '@dwg/shared';
import { request } from './api-client';

export async function fetchDashboard(): Promise<DashboardResponse> {
  return request('/api/v1/dashboard', DashboardResponseSchema, { method: 'GET' });
}
