/**
 * `GET /api/v1/mail/capabilities` — the single document every mail page
 * reads to decide whether to render its normal view or a real
 * `UnsupportedNotice` (FEATURE_MATRIX.md §7; UX_ARCHITECTURE.md §9). The
 * server-side mutation guards in `capability-guards.ts` read the exact
 * same `DmsDriver.getCapabilities()` call, so the UI and the enforcement
 * can never disagree about what this deployment supports.
 */
import type { FastifyInstance } from 'fastify';
import { MailCapabilitiesResponseSchema } from '@dwg/shared';
import type { DmsDriver } from '../../drivers/dms/index.js';
import type { AuthMiddleware } from '../auth/auth.middleware.js';

export interface MailCapabilitiesRoutesDeps {
  readonly driver: DmsDriver;
  readonly middleware: AuthMiddleware;
}

export async function registerMailCapabilitiesRoutes(
  app: FastifyInstance,
  deps: MailCapabilitiesRoutesDeps,
): Promise<void> {
  const { driver, middleware } = deps;
  const { requireSession } = middleware;

  await app.register(
    async (capabilitiesApp) => {
      capabilitiesApp.addHook('preHandler', requireSession());

      capabilitiesApp.get('/', async (_request, reply) => {
        const capabilities = await driver.getCapabilities();
        void reply.send(MailCapabilitiesResponseSchema.parse(capabilities));
      });
    },
    { prefix: '/api/v1/mail/capabilities' },
  );
}
