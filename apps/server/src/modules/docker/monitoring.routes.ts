/**
 * `/api/v1/docker/monitoring` (M9 — FEATURE_MATRIX.md §26). Read-only —
 * one snapshot of container stats plus host-level Docker system info.
 */
import type { FastifyInstance } from 'fastify';
import { MonitoringResponseSchema } from '@dwg/shared';
import type { AuthMiddleware } from '../auth/auth.middleware.js';
import type { MonitoringService } from './monitoring.service.js';

export interface MonitoringRoutesDeps {
  readonly monitoringService: MonitoringService;
  readonly middleware: AuthMiddleware;
}

export async function registerMonitoringRoutes(
  app: FastifyInstance,
  deps: MonitoringRoutesDeps,
): Promise<void> {
  const { monitoringService, middleware } = deps;
  const { requireSession, requireCsrf, requirePermission } = middleware;

  await app.register(
    async (monitoringApp) => {
      monitoringApp.addHook('preHandler', requireSession());
      monitoringApp.addHook('preHandler', requireCsrf());
      monitoringApp.addHook('preHandler', requirePermission('docker:manage'));

      monitoringApp.get('/', async (_request, reply) => {
        const snapshot = await monitoringService.getSnapshot();
        void reply.send(MonitoringResponseSchema.parse(snapshot));
      });
    },
    { prefix: '/api/v1/docker/monitoring' },
  );
}
