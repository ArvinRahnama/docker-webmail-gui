/**
 * `/api/v1/docker/containers/*` (M9 — FEATURE_MATRIX.md §24). Listing and
 * inspecting are reads; start/stop/restart are mutations against "the"
 * managed mail container and are each audited (`platform/audit.ts`) —
 * there is no route here that takes a container id, matching the broker's
 * own container-identity resolution (ARCHITECTURE.md §6).
 *
 * **`container.create`/recreate do not exist here.** Recreate is
 * explicitly deferred (the milestone brief) because it needs
 * `container.create`, which the broker deliberately lacks
 * (docs/research/02-docker-api-security.md §A.1).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ContainerInspectResponseSchema,
  ContainerListResponseSchema,
  OperationAckSchema,
} from '@dwg/shared';
import { recordAuditEvent, type AuditAction } from '../../platform/audit.js';
import type { Database } from '../../platform/db.js';
import { requireAuthContext, type AuthMiddleware } from '../auth/auth.middleware.js';
import type { ContainersService } from './containers.service.js';

export interface ContainersRoutesDeps {
  readonly db: Database;
  readonly containersService: ContainersService;
  readonly middleware: AuthMiddleware;
}

export async function registerContainersRoutes(
  app: FastifyInstance,
  deps: ContainersRoutesDeps,
): Promise<void> {
  const { db, containersService, middleware } = deps;
  const { requireSession, requireCsrf, requirePermission } = middleware;

  await app.register(
    async (containersApp) => {
      containersApp.addHook('preHandler', requireSession());
      containersApp.addHook('preHandler', requireCsrf());
      containersApp.addHook('preHandler', requirePermission('docker:manage'));

      containersApp.get('/', async (_request, reply) => {
        const containers = await containersService.list();
        void reply.send(ContainerListResponseSchema.parse({ containers }));
      });

      containersApp.get('/managed', async (_request, reply) => {
        const managed = await containersService.getManaged();
        void reply.send(ContainerInspectResponseSchema.parse(managed));
      });

      function lifecycleHandler(
        auditAction: AuditAction,
        run: () => Promise<void>,
      ): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
        return async (request, reply) => {
          const auth = requireAuthContext(request);
          await run();
          recordAuditEvent(db, {
            actor: { adminId: auth.admin.id, label: auth.admin.email },
            action: auditAction,
            target: { type: 'container', id: 'managed' },
            result: 'success',
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          });
          void reply.send(OperationAckSchema.parse({ ok: true }));
        };
      }

      containersApp.post(
        '/managed/start',
        lifecycleHandler('container.start', () => containersService.start()),
      );
      containersApp.post(
        '/managed/stop',
        lifecycleHandler('container.stop', () => containersService.stop()),
      );
      containersApp.post(
        '/managed/restart',
        lifecycleHandler('container.restart', () => containersService.restart()),
      );
    },
    { prefix: '/api/v1/docker/containers' },
  );
}
