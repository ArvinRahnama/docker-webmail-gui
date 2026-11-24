/**
 * `/api/v1/security/fail2ban/*` (`docs/research/03-mail-stack-components.md`
 * §10). Status is a read; ban/unban are mutations, each audited
 * (`platform/audit.ts`) — unban in particular restores network access for
 * a previously-blocked IP, which FEATURE_MATRIX.md §16b requires
 * confirmation for — enforced client-side (`ConfirmDialog`) and recorded
 * here regardless.
 */
import type { FastifyInstance } from 'fastify';
import {
  Fail2banAllowlistIpRequestSchema,
  Fail2banAllowlistResponseSchema,
  Fail2banIpRequestSchema,
  Fail2banStatusResponseSchema,
  Fail2banWriteResponseSchema,
} from '@dwg/shared';
import { recordAuditEvent } from '../../platform/audit.js';
import type { Database } from '../../platform/db.js';
import { requireAuthContext, type AuthMiddleware } from '../auth/auth.middleware.js';
import { parseBody } from '../auth/auth.routes.js';
import type { Fail2banService } from './fail2ban.service.js';

export interface Fail2banRoutesDeps {
  readonly db: Database;
  readonly fail2banService: Fail2banService;
  readonly middleware: AuthMiddleware;
}

export async function registerFail2banRoutes(
  app: FastifyInstance,
  deps: Fail2banRoutesDeps,
): Promise<void> {
  const { db, fail2banService, middleware } = deps;
  const { requireSession, requireCsrf, requirePermission } = middleware;

  await app.register(
    async (fail2banApp) => {
      fail2banApp.addHook('preHandler', requireSession());
      fail2banApp.addHook('preHandler', requireCsrf());
      fail2banApp.addHook('preHandler', requirePermission('security:manage'));

      fail2banApp.get('/', async (_request, reply) => {
        const status = await fail2banService.getStatus();
        void reply.send(Fail2banStatusResponseSchema.parse(status));
      });

      fail2banApp.get('/allowlist', async (_request, reply) => {
        const ips = await fail2banService.getAllowlist();
        void reply.send(Fail2banAllowlistResponseSchema.parse(ips));
      });

      for (const action of ['add', 'remove'] as const) {
        fail2banApp.post(`/allowlist/${action}`, async (request, reply) => {
          const auth = requireAuthContext(request);
          const { ip } = parseBody(Fail2banAllowlistIpRequestSchema, request.body);
          await fail2banService.changeAllowlist(action, ip);

          recordAuditEvent(db, {
            actor: { adminId: auth.admin.id, label: auth.admin.email },
            action: `fail2ban.allowlist.${action}`,
            target: { type: 'ip', id: ip },
            result: 'success',
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
            details: { jail: 'postfix' },
          });

          void reply.send(Fail2banWriteResponseSchema.parse({ ok: true }));
        });
      }

      fail2banApp.post('/ban', async (request, reply) => {
        const auth = requireAuthContext(request);
        const body = parseBody(Fail2banIpRequestSchema, request.body);

        await fail2banService.ban(body.ip);

        recordAuditEvent(db, {
          actor: { adminId: auth.admin.id, label: auth.admin.email },
          action: 'fail2ban.ban',
          target: { type: 'ip', id: body.ip },
          result: 'success',
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          details: { bannedIp: body.ip },
        });

        void reply.send(Fail2banWriteResponseSchema.parse({ ok: true }));
      });

      fail2banApp.post('/unban', async (request, reply) => {
        const auth = requireAuthContext(request);
        const body = parseBody(Fail2banIpRequestSchema, request.body);

        await fail2banService.unban(body.ip);

        recordAuditEvent(db, {
          actor: { adminId: auth.admin.id, label: auth.admin.email },
          action: 'fail2ban.unban',
          target: { type: 'ip', id: body.ip },
          result: 'success',
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          details: { unbannedIp: body.ip },
        });

        void reply.send(Fail2banWriteResponseSchema.parse({ ok: true }));
      });
    },
    { prefix: '/api/v1/security/fail2ban' },
  );
}
