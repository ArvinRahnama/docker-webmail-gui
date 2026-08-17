/**
 * `/api/v1/docker/networks` (M9 — FEATURE_MATRIX.md §24). Read-only
 * (AGENT_BRIEF.md §4) — one route, no mutations, nothing audited.
 */
import type { FastifyInstance } from 'fastify';
import { NetworkListResponseSchema } from '@dwg/shared';
import type { AuthMiddleware } from '../auth/auth.middleware.js';
import type { NetworksService } from './networks.service.js';

export interface NetworksRoutesDeps {
  readonly networksService: NetworksService;
  readonly middleware: AuthMiddleware;
}

export async function registerNetworksRoutes(
  app: FastifyInstance,
  deps: NetworksRoutesDeps,
): Promise<void> {
  const { networksService, middleware } = deps;
  const { requireSession, requireCsrf, requirePermission } = middleware;

  await app.register(
    async (networksApp) => {
      networksApp.addHook('preHandler', requireSession());
      networksApp.addHook('preHandler', requireCsrf());
      networksApp.addHook('preHandler', requirePermission('docker:manage'));

      networksApp.get('/', async (_request, reply) => {
        const networks = await networksService.list();
        void reply.send(NetworkListResponseSchema.parse({ networks }));
      });
    },
    { prefix: '/api/v1/docker/networks' },
  );
}
