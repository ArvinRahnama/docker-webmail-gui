/**
 * `/api/v1/updates/*` (M10 — IMPLEMENTATION_PLAN.md §2.2). `GET /` is a
 * pure read (current vs available, backup-gate facts, the rollback
 * caveat — always present, per that field's own schema comment). `POST
 * /apply` always refuses with `CAPABILITY_UNSUPPORTED` and audits the
 * refusal — see `updates.service.ts`'s header for exactly why apply is
 * deferred, not merely unimplemented-and-silent.
 */
import type { FastifyInstance } from 'fastify';
import { UpdateStatusResponseSchema } from '@dwg/shared';
import { recordAuditEvent } from '../../platform/audit.js';
import type { Database } from '../../platform/db.js';
import { requireAuthContext, type AuthMiddleware } from '../auth/auth.middleware.js';
import type { UpdatesService } from './updates.service.js';

export interface UpdatesRoutesDeps {
  readonly db: Database;
  readonly updatesService: UpdatesService;
  readonly middleware: AuthMiddleware;
}

export async function registerUpdatesRoutes(
  app: FastifyInstance,
  deps: UpdatesRoutesDeps,
): Promise<void> {
  const { db, updatesService, middleware } = deps;
  const { requireSession, requireCsrf, requirePermission } = middleware;

  await app.register(
    async (updatesApp) => {
      updatesApp.addHook('preHandler', requireSession());
      updatesApp.addHook('preHandler', requireCsrf());
      updatesApp.addHook('preHandler', requirePermission('maintenance:manage'));

      updatesApp.get('/', async (_request, reply) => {
        const status = await updatesService.getStatus();
        void reply.send(UpdateStatusResponseSchema.parse(status));
      });

      updatesApp.post('/apply', async (request) => {
        const auth = requireAuthContext(request);
        recordAuditEvent(db, {
          actor: { adminId: auth.admin.id, label: auth.admin.email },
          action: 'update.apply_refused',
          target: null,
          result: 'success',
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });
        // Always throws — see `UpdatesService.applyRefused`'s doc
        // comment. The uniform error handler turns this into a
        // `CAPABILITY_UNSUPPORTED` response; there is no reply to send
        // on the success path because there is no success path.
        updatesService.applyRefused();
      });
    },
    { prefix: '/api/v1/updates' },
  );
}
