/**
 * `/api/v1/notifications/*` (M11 — ARCHITECTURE.md §7.3). Session-only,
 * same reasoning as `modules/dashboard/dashboard.routes.ts`: a
 * notification can originate from any subsystem, so it is not gated
 * behind any one management permission.
 *
 * "Dismiss" (UX_ARCHITECTURE.md §8's Tier 1 example) is
 * `POST /:id/read` — see `notifications.service.ts`'s header for why this
 * marks read rather than resolving.
 */
import type { FastifyInstance } from 'fastify';
import { NotificationListResponseSchema, OperationAckSchema } from '@dwg/shared';
import type { AuthMiddleware } from '../auth/auth.middleware.js';
import type { NotificationsService } from './notifications.service.js';

export interface NotificationsRoutesDeps {
  readonly notificationsService: NotificationsService;
  readonly middleware: AuthMiddleware;
}

export async function registerNotificationsRoutes(
  app: FastifyInstance,
  deps: NotificationsRoutesDeps,
): Promise<void> {
  const { notificationsService, middleware } = deps;
  const { requireSession, requireCsrf } = middleware;

  await app.register(
    async (notificationsApp) => {
      notificationsApp.addHook('preHandler', requireSession());
      notificationsApp.addHook('preHandler', requireCsrf());

      notificationsApp.get('/', async (_request, reply) => {
        void reply.send(NotificationListResponseSchema.parse(notificationsService.list()));
      });

      notificationsApp.post<{ Params: { id: string } }>('/:id/read', async (request, reply) => {
        notificationsService.markRead(request.params.id);
        void reply.send(OperationAckSchema.parse({ ok: true }));
      });

      notificationsApp.post('/read-all', async (_request, reply) => {
        notificationsService.markAllRead();
        void reply.send(OperationAckSchema.parse({ ok: true }));
      });
    },
    { prefix: '/api/v1/notifications' },
  );
}
