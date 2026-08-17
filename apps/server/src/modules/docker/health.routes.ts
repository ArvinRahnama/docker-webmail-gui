/**
 * `/api/v1/docker/health` (M9 — FEATURE_MATRIX.md §26). Read-only — the
 * health centre's entire surface is `HealthService.getChecks()`, whose own
 * doc comment carries the independence guarantee this route relies on.
 */
import type { FastifyInstance } from 'fastify';
import { HealthCentreResponseSchema } from '@dwg/shared';
import type { AuthMiddleware } from '../auth/auth.middleware.js';
import type { HealthService } from './health.service.js';

export interface HealthRoutesDeps {
  readonly healthService: HealthService;
  readonly middleware: AuthMiddleware;
}

export async function registerDockerHealthRoutes(
  app: FastifyInstance,
  deps: HealthRoutesDeps,
): Promise<void> {
  const { healthService, middleware } = deps;
  const { requireSession, requireCsrf, requirePermission } = middleware;

  await app.register(
    async (healthApp) => {
      healthApp.addHook('preHandler', requireSession());
      healthApp.addHook('preHandler', requireCsrf());
      healthApp.addHook('preHandler', requirePermission('docker:manage'));

      healthApp.get('/', async (_request, reply) => {
        const checks = await healthService.getChecks();
        void reply.send(HealthCentreResponseSchema.parse({ checks }));
      });
    },
    { prefix: '/api/v1/docker/health' },
  );
}
