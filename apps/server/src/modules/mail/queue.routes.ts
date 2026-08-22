/**
 * `GET /api/v1/mail/queue` (M11 gap-closing pass — UX_ARCHITECTURE.md
 * §5.2). Read-only, same `mail:manage` gate every other mail read uses
 * (`domains.routes.ts`, `mailboxes.routes.ts`) — there is no `POST`,
 * `PATCH` or `DELETE` handler anywhere in this file, matching
 * `domains.routes.ts`'s own precedent for a resource this API
 * deliberately cannot mutate yet (`queue.service.ts`'s header explains
 * why: flush/hold/delete are a named, reachable gap, not a control this
 * route could accept but the backend could not perform).
 */
import type { FastifyInstance } from 'fastify';
import { MailQueueListResponseSchema } from '@dwg/shared';
import type { AuthMiddleware } from '../auth/auth.middleware.js';
import type { QueueService } from './queue.service.js';

export interface QueueRoutesDeps {
  readonly queueService: QueueService;
  readonly middleware: AuthMiddleware;
}

export async function registerQueueRoutes(
  app: FastifyInstance,
  deps: QueueRoutesDeps,
): Promise<void> {
  const { queueService, middleware } = deps;
  const { requireSession, requireCsrf, requirePermission } = middleware;

  await app.register(
    async (queueApp) => {
      queueApp.addHook('preHandler', requireSession());
      queueApp.addHook('preHandler', requireCsrf());
      queueApp.addHook('preHandler', requirePermission('mail:manage'));

      queueApp.get('/', async (_request, reply) => {
        const list = await queueService.list();
        void reply.send(MailQueueListResponseSchema.parse(list));
      });
    },
    { prefix: '/api/v1/mail/queue' },
  );
}
