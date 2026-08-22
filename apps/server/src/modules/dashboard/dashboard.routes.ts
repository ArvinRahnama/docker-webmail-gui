/**
 * `GET /api/v1/dashboard` (M11 — IMPLEMENTATION_PLAN.md §3). A pure read,
 * gated on `requireSession` only — no `requirePermission` call, matching
 * `auth.routes.ts`'s own session-only endpoints (`/auth/session`,
 * `/auth/csrf-token`): a dashboard is a cross-cutting overview every
 * authenticated admin should see, not one subsystem's management
 * surface, so it does not belong behind any single `docker:manage` /
 * `security:manage` / `maintenance:manage`-style gate.
 */
import type { FastifyInstance } from 'fastify';
import { DashboardResponseSchema } from '@dwg/shared';
import type { AuthMiddleware } from '../auth/auth.middleware.js';
import type { DashboardService } from './dashboard.service.js';

export interface DashboardRoutesDeps {
  readonly dashboardService: DashboardService;
  readonly middleware: AuthMiddleware;
}

export async function registerDashboardRoutes(
  app: FastifyInstance,
  deps: DashboardRoutesDeps,
): Promise<void> {
  const { dashboardService, middleware } = deps;

  await app.register(
    async (dashboardApp) => {
      dashboardApp.addHook('preHandler', middleware.requireSession());

      dashboardApp.get('/', async (_request, reply) => {
        const snapshot = await dashboardService.getSnapshot();
        void reply.send(DashboardResponseSchema.parse(snapshot));
      });
    },
    { prefix: '/api/v1/dashboard' },
  );
}
