/**
 * `/api/v1/docker/volumes/*` (M9 — FEATURE_MATRIX.md §25). `DELETE
 * /:name` is the one destructive route in this module — confirmed
 * client-side (`ConfirmDialog`, tier 3: type-to-confirm) and always
 * audited here, but the actual refusal for a protected DMS volume happens
 * broker-side (`apps/broker/src/operations.ts`), independently of
 * anything this route does. A refusal surfaces as an ordinary `FORBIDDEN`
 * response (`platform/errors.ts`'s `mapBrokerClientError`) — never a
 * silent no-op and never something this route could accidentally bypass.
 */
import type { FastifyInstance } from 'fastify';
import { DockerVolumeListResponseSchema, OperationAckSchema } from '@dwg/shared';
import { recordAuditEvent } from '../../platform/audit.js';
import type { Database } from '../../platform/db.js';
import { requireAuthContext, type AuthMiddleware } from '../auth/auth.middleware.js';
import type { VolumesService } from './volumes.service.js';

export interface VolumesRoutesDeps {
  readonly db: Database;
  readonly volumesService: VolumesService;
  readonly middleware: AuthMiddleware;
}

export async function registerVolumesRoutes(
  app: FastifyInstance,
  deps: VolumesRoutesDeps,
): Promise<void> {
  const { db, volumesService, middleware } = deps;
  const { requireSession, requireCsrf, requirePermission } = middleware;

  await app.register(
    async (volumesApp) => {
      volumesApp.addHook('preHandler', requireSession());
      volumesApp.addHook('preHandler', requireCsrf());
      volumesApp.addHook('preHandler', requirePermission('docker:manage'));

      volumesApp.get('/', async (_request, reply) => {
        const volumes = await volumesService.list();
        void reply.send(DockerVolumeListResponseSchema.parse({ volumes }));
      });

      volumesApp.delete<{ Params: { name: string } }>('/:name', async (request, reply) => {
        const auth = requireAuthContext(request);
        const { name } = request.params;

        await volumesService.remove(name);

        recordAuditEvent(db, {
          actor: { adminId: auth.admin.id, label: auth.admin.email },
          action: 'volume.remove',
          target: { type: 'volume', id: name },
          result: 'success',
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });

        void reply.send(OperationAckSchema.parse({ ok: true }));
      });
    },
    { prefix: '/api/v1/docker/volumes' },
  );
}
