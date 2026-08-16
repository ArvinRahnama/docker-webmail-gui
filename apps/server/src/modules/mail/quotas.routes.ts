/**
 * `/api/v1/quotas` — the Storage report (FEATURE_MATRIX.md §7;
 * UX_ARCHITECTURE.md §5.1 row 5). **`GET` only.** Setting or clearing a
 * quota is a mailbox operation (`PUT|DELETE /api/v1/mailboxes/:address/quota`
 * — `mailboxes.routes.ts`), reached from the mailbox this page links to,
 * never from here.
 */
import type { FastifyInstance } from 'fastify';
import { QuotaListResponseSchema } from '@dwg/shared';
import type { AuthMiddleware } from '../auth/auth.middleware.js';
import type { QuotasService } from './quotas.service.js';

export interface QuotasRoutesDeps {
  readonly quotasService: QuotasService;
  readonly middleware: AuthMiddleware;
}

export async function registerQuotasRoutes(
  app: FastifyInstance,
  deps: QuotasRoutesDeps,
): Promise<void> {
  const { quotasService, middleware } = deps;
  const { requireSession, requireCsrf, requirePermission } = middleware;

  await app.register(
    async (quotasApp) => {
      quotasApp.addHook('preHandler', requireSession());
      quotasApp.addHook('preHandler', requireCsrf());
      quotasApp.addHook('preHandler', requirePermission('mail:manage'));

      quotasApp.get('/', async (_request, reply) => {
        const entries = await quotasService.listReport();
        void reply.send(QuotaListResponseSchema.parse({ entries }));
      });
    },
    { prefix: '/api/v1/quotas' },
  );
}
