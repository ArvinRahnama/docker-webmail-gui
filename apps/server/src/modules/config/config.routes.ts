/**
 * `/api/v1/config/*` (M10 — this milestone's brief: "validate -> diff ->
 * explain restart/recreate impact -> confirm -> apply -> verify ->
 * audit"). `POST /validate` is the diff+impact step, callable as often as
 * the UI wants while an admin is still editing; `POST /apply` re-runs the
 * exact same check server-side (`ConfigService.apply`) before ever
 * writing anything, so a stale or hand-crafted request cannot skip
 * straight past a refusal `/validate` would have shown.
 *
 * Revealing a secret (`POST /settings/:key/reveal`) is audited right
 * here, unconditionally, on every successful call — ARCHITECTURE.md
 * §7.6's "revealing a masked secret is itself an audited event" is not
 * something a future change to this route could accidentally skip only
 * for some call paths, because there is only one.
 */
import type { FastifyInstance } from 'fastify';
import {
  ApplyConfigRequestSchema,
  ApplyConfigResponseSchema,
  ConfigSettingsResponseSchema,
  ConfigSnapshotListResponseSchema,
  RevealSettingResponseSchema,
  RollbackConfigRequestSchema,
  ValidateConfigRequestSchema,
  ValidateConfigResponseSchema,
} from '@dwg/shared';
import { recordAuditEvent } from '../../platform/audit.js';
import type { Database } from '../../platform/db.js';
import { requireAuthContext, type AuthMiddleware } from '../auth/auth.middleware.js';
import { parseBody } from '../auth/auth.routes.js';
import type { ConfigService } from './config.service.js';

export interface ConfigRoutesDeps {
  readonly db: Database;
  readonly configService: ConfigService;
  readonly middleware: AuthMiddleware;
}

export async function registerConfigRoutes(
  app: FastifyInstance,
  deps: ConfigRoutesDeps,
): Promise<void> {
  const { db, configService, middleware } = deps;
  const { requireSession, requireCsrf, requirePermission } = middleware;

  await app.register(
    async (configApp) => {
      configApp.addHook('preHandler', requireSession());
      configApp.addHook('preHandler', requireCsrf());
      configApp.addHook('preHandler', requirePermission('maintenance:manage'));

      configApp.get('/settings', async (_request, reply) => {
        void reply.send(ConfigSettingsResponseSchema.parse(configService.describe()));
      });

      configApp.post<{ Params: { key: string } }>(
        '/settings/:key/reveal',
        async (request, reply) => {
          const auth = requireAuthContext(request);
          const result = configService.reveal(request.params.key);

          // Unconditional: every successful reveal is audited, regardless
          // of whether the value turns out to be set — see the module
          // header.
          recordAuditEvent(db, {
            actor: { adminId: auth.admin.id, label: auth.admin.email },
            action: 'config.reveal_secret',
            target: { type: 'setting', id: request.params.key },
            result: 'success',
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          });

          void reply.send(RevealSettingResponseSchema.parse(result));
        },
      );

      configApp.post('/validate', async (request, reply) => {
        const body = parseBody(ValidateConfigRequestSchema, request.body);
        void reply.send(ValidateConfigResponseSchema.parse(configService.validate(body.changes)));
      });

      configApp.post('/apply', async (request, reply) => {
        const auth = requireAuthContext(request);
        const body = parseBody(ApplyConfigRequestSchema, request.body);
        const result = configService.apply(body.changes, {
          adminId: auth.admin.id,
          label: auth.admin.email,
        });

        // `keys`, never values — some of `body.changes`'s values are
        // secrets (SECURITY.md §3.10; `platform/audit.ts`'s own
        // denylist-key discipline is the second line of defence, this is
        // the first: never construct the payload with a secret in it at
        // all).
        recordAuditEvent(db, {
          actor: { adminId: auth.admin.id, label: auth.admin.email },
          action: 'config.apply',
          target: { type: 'config-snapshot', id: result.snapshotId },
          result: 'success',
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          details: { keys: result.applied.join(',') },
        });

        void reply.send(ApplyConfigResponseSchema.parse(result));
      });

      configApp.get('/snapshots', async (_request, reply) => {
        void reply.send(
          ConfigSnapshotListResponseSchema.parse({ snapshots: configService.listSnapshots() }),
        );
      });

      configApp.post<{ Params: { id: string } }>(
        '/snapshots/:id/rollback',
        async (request, reply) => {
          const auth = requireAuthContext(request);
          parseBody(RollbackConfigRequestSchema, request.body);
          const result = configService.rollback(request.params.id, {
            adminId: auth.admin.id,
            label: auth.admin.email,
          });

          recordAuditEvent(db, {
            actor: { adminId: auth.admin.id, label: auth.admin.email },
            action: 'config.apply',
            target: { type: 'config-snapshot', id: result.snapshotId },
            result: 'success',
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
            details: { keys: result.applied.join(','), rolledBackFrom: request.params.id },
          });

          void reply.send(ApplyConfigResponseSchema.parse(result));
        },
      );
    },
    { prefix: '/api/v1/config' },
  );
}
