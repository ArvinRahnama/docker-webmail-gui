/**
 * `/api/v1/docker/console/*` (M9 — FEATURE_MATRIX.md §32). Behind
 * `ENABLE_EXEC_CONSOLE`, off by default — `GET /` always reports
 * availability (so the UI can render a real "disabled" state rather than
 * a 404), and `POST /exec` refuses with `CAPABILITY_UNSUPPORTED` when the
 * flag is off, before ever reaching the broker (`ConsoleService`). `command`
 * is validated against the fixed `ConsoleCommandSchema` enum
 * (`@dwg/shared`) by `parseBody` below — an out-of-enum value is a
 * `VALIDATION_FAILED` 400 here, never forwarded to the broker (which
 * enforces the same enum independently regardless).
 */
import type { FastifyInstance } from 'fastify';
import {
  ConsoleAvailabilityResponseSchema,
  ConsoleCommandRequestSchema,
  ConsoleExecResponseSchema,
} from '@dwg/shared';
import { recordAuditEvent } from '../../platform/audit.js';
import type { Database } from '../../platform/db.js';
import { requireAuthContext, type AuthMiddleware } from '../auth/auth.middleware.js';
import { parseBody } from '../auth/auth.routes.js';
import type { ConsoleService } from './console.service.js';

export interface ConsoleRoutesDeps {
  readonly db: Database;
  readonly consoleService: ConsoleService;
  readonly middleware: AuthMiddleware;
}

export async function registerConsoleRoutes(
  app: FastifyInstance,
  deps: ConsoleRoutesDeps,
): Promise<void> {
  const { db, consoleService, middleware } = deps;
  const { requireSession, requireCsrf, requirePermission } = middleware;

  await app.register(
    async (consoleApp) => {
      consoleApp.addHook('preHandler', requireSession());
      consoleApp.addHook('preHandler', requireCsrf());
      consoleApp.addHook('preHandler', requirePermission('docker:manage'));

      consoleApp.get('/', async (_request, reply) => {
        const capability = consoleService.getAvailability();
        void reply.send(ConsoleAvailabilityResponseSchema.parse({ capability }));
      });

      consoleApp.post('/exec', async (request, reply) => {
        const auth = requireAuthContext(request);
        const body = parseBody(ConsoleCommandRequestSchema, request.body);

        const result = await consoleService.exec(body.command);

        recordAuditEvent(db, {
          actor: { adminId: auth.admin.id, label: auth.admin.email },
          action: 'console.exec',
          target: { type: 'console-command', id: body.command },
          result: 'success',
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          details: { exitCode: result.exitCode, durationMs: result.durationMs },
        });

        void reply.send(ConsoleExecResponseSchema.parse(result));
      });
    },
    { prefix: '/api/v1/docker/console' },
  );
}
