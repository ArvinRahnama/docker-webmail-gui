/**
 * `/api/v1/security/autoresponder/*` (FEATURE_MATRIX.md §18). Status is a
 * read; update is a mutation, audited — it always carries the subject and
 * date window (safe, non-sensitive), never the message body, matching
 * `rspamd.routes.ts`'s "audit the fact and its shape, not the content"
 * convention for free-text fields.
 */
import type { FastifyInstance } from 'fastify';
import { AutoresponderStatusResponseSchema, UpdateAutoresponderRequestSchema } from '@dwg/shared';
import { recordAuditEvent } from '../../platform/audit.js';
import type { Database } from '../../platform/db.js';
import { requireAuthContext, type AuthMiddleware } from '../auth/auth.middleware.js';
import { parseBody } from '../auth/auth.routes.js';
import type { AutoresponderService } from './autoresponder.service.js';

export interface AutoresponderRoutesDeps {
  readonly db: Database;
  readonly autoresponderService: AutoresponderService;
  readonly middleware: AuthMiddleware;
}

export async function registerAutoresponderRoutes(
  app: FastifyInstance,
  deps: AutoresponderRoutesDeps,
): Promise<void> {
  const { db, autoresponderService, middleware } = deps;
  const { requireSession, requireCsrf, requirePermission } = middleware;

  await app.register(
    async (autoresponderApp) => {
      autoresponderApp.addHook('preHandler', requireSession());
      autoresponderApp.addHook('preHandler', requireCsrf());
      autoresponderApp.addHook('preHandler', requirePermission('security:manage'));

      autoresponderApp.get<{ Params: { user: string } }>('/:user', async (request, reply) => {
        const status = await autoresponderService.getStatus(request.params.user);
        void reply.send(AutoresponderStatusResponseSchema.parse({ status }));
      });

      autoresponderApp.put<{ Params: { user: string } }>('/:user', async (request, reply) => {
        const auth = requireAuthContext(request);
        const body = parseBody(UpdateAutoresponderRequestSchema, request.body);
        const { user } = request.params;

        const status = await autoresponderService.update(user, body);

        recordAuditEvent(db, {
          actor: { adminId: auth.admin.id, label: auth.admin.email },
          action: 'autoresponder.update',
          target: { type: 'mailbox', id: user },
          result: 'success',
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          details: {
            user,
            enabled: body.enabled,
            subject: body.subject,
            startDate: body.startDate ?? null,
            endDate: body.endDate ?? null,
          },
        });

        void reply.send(AutoresponderStatusResponseSchema.parse({ status }));
      });
    },
    { prefix: '/api/v1/security/autoresponder' },
  );
}
