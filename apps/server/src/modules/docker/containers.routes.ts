/**
 * `/api/v1/docker/containers/*` (M9 — FEATURE_MATRIX.md §22-23). Listing and
 * inspecting are reads; start/stop/restart are mutations against "the"
 * managed mail container and are each audited (`platform/audit.ts`) —
 * there is no route here that takes a container id, matching the broker's
 * own container-identity resolution (ARCHITECTURE.md §6).
 *
 * **`container.create`/recreate do not exist here.** Recreate does not
 * ship at all (FEATURE_MATRIX.md §22): it needs `container.create`, which
 * the broker deliberately lacks because that call grants host root
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

      // Restart the panel's own server container. Unlike the managed-
      // container lifecycle above, this operation takes *this* server down,
      // dropping the very request that triggered it — so the audit is
      // written BEFORE the broker is called, or a successful restart would
      // leave no trace (working agreement #6). The broker refuses without
      // restarting anything if the panel-server identity is misconfigured,
      // and that error still reaches the client; the audit records that a
      // restart was initiated by this admin either way. The client does not
      // wait on this response — it reconnects by polling `/api/v1/health`.
      containersApp.post('/panel/restart', async (request, reply) => {
        const auth = requireAuthContext(request);
        recordAuditEvent(db, {
          actor: { adminId: auth.admin.id, label: auth.admin.email },
          action: 'panel.restart',
          target: { type: 'container', id: 'panel' },
          result: 'success',
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });
        await containersService.restartPanel();
        void reply.send(OperationAckSchema.parse({ ok: true }));
      });
    },
    { prefix: '/api/v1/docker/containers' },
  );
}
