/**
 * `/api/v1/security/sieve/*` (FEATURE_MATRIX.md §17). List/get are reads;
 * put/activate/deactivate are mutations, each audited
 * (`platform/audit.ts`). `:user` is always the mailbox's email address,
 * matching `doveadm sieve`'s own `-u <user>` — validated the same way as
 * every other DMS address leaf (`drivers/dms/validators.ts`'s
 * `validateAddressForArgv`, reached via `commands.ts`'s builders).
 */
import type { FastifyInstance } from 'fastify';
import {
  PutSieveScriptRequestSchema,
  SieveScriptDetailResponseSchema,
  SieveScriptListResponseSchema,
  SieveWriteResponseSchema,
} from '@dwg/shared';
import { recordAuditEvent } from '../../platform/audit.js';
import type { Database } from '../../platform/db.js';
import { requireAuthContext, type AuthMiddleware } from '../auth/auth.middleware.js';
import { parseBody } from '../auth/auth.routes.js';
import type { SieveService } from './sieve.service.js';

export interface SieveRoutesDeps {
  readonly db: Database;
  readonly sieveService: SieveService;
  readonly middleware: AuthMiddleware;
}

export async function registerSieveRoutes(
  app: FastifyInstance,
  deps: SieveRoutesDeps,
): Promise<void> {
  const { db, sieveService, middleware } = deps;
  const { requireSession, requireCsrf, requirePermission } = middleware;

  await app.register(
    async (sieveApp) => {
      sieveApp.addHook('preHandler', requireSession());
      sieveApp.addHook('preHandler', requireCsrf());
      sieveApp.addHook('preHandler', requirePermission('security:manage'));

      sieveApp.get<{ Params: { user: string } }>('/:user', async (request, reply) => {
        const scripts = await sieveService.list(request.params.user);
        void reply.send(SieveScriptListResponseSchema.parse({ scripts }));
      });

      sieveApp.get<{ Params: { user: string; name: string } }>(
        '/:user/:name',
        async (request, reply) => {
          const detail = await sieveService.get(request.params.user, request.params.name);
          void reply.send(SieveScriptDetailResponseSchema.parse(detail));
        },
      );

      sieveApp.put<{ Params: { user: string; name: string } }>(
        '/:user/:name',
        async (request, reply) => {
          const auth = requireAuthContext(request);
          const body = parseBody(PutSieveScriptRequestSchema, request.body);
          const { user, name } = request.params;

          await sieveService.put(user, name, body.content);

          recordAuditEvent(db, {
            actor: { adminId: auth.admin.id, label: auth.admin.email },
            action: 'sieve.script_update',
            target: { type: 'sieve-script', id: `${user}/${name}` },
            result: 'success',
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
            // Never the script body itself — scripts can encode arbitrary
            // filter logic an admin may consider sensitive; length is
            // enough to audit "a script was written" (mirrors
            // `rspamd.routes.ts`'s learn-spam/-ham audit entries).
            details: { user, name, contentLength: body.content.length },
          });

          void reply.send(SieveWriteResponseSchema.parse({ ok: true }));
        },
      );

      sieveApp.post<{ Params: { user: string; name: string } }>(
        '/:user/:name/activate',
        async (request, reply) => {
          const auth = requireAuthContext(request);
          const { user, name } = request.params;

          await sieveService.activate(user, name);

          recordAuditEvent(db, {
            actor: { adminId: auth.admin.id, label: auth.admin.email },
            action: 'sieve.script_activate',
            target: { type: 'sieve-script', id: `${user}/${name}` },
            result: 'success',
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
            details: { user, name },
          });

          void reply.send(SieveWriteResponseSchema.parse({ ok: true }));
        },
      );

      sieveApp.post<{ Params: { user: string } }>('/:user/deactivate', async (request, reply) => {
        const auth = requireAuthContext(request);
        const { user } = request.params;

        await sieveService.deactivate(user);

        recordAuditEvent(db, {
          actor: { adminId: auth.admin.id, label: auth.admin.email },
          action: 'sieve.script_deactivate',
          target: { type: 'sieve-mailbox', id: user },
          result: 'success',
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          details: { user },
        });

        void reply.send(SieveWriteResponseSchema.parse({ ok: true }));
      });
    },
    { prefix: '/api/v1/security/sieve' },
  );
}
