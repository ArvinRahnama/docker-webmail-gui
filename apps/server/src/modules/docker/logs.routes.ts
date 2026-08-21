/**
 * `/api/v1/docker/logs/*` (M9 — FEATURE_MATRIX.md §19-21). Read-only.
 * `GET /file/:source` validates `:source` against the fixed two-value
 * `LogFileSourceSchema` (`@dwg/shared`) *before* it ever reaches
 * `LogsService`/the broker — a value outside the enum, including a
 * path-traversal attempt (`../../etc/passwd`) or an absolute path, fails
 * this route's own validation and never becomes a broker call at all. The
 * broker enforces the same fixed enum independently
 * (`apps/broker/src/operations.ts`), so this is defence in depth, not the
 * only place the restriction exists.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ContainerLogsResponseSchema,
  LogFileSourceSchema,
  LogsFileResponseSchema,
  LOGS_TAIL_MAX,
  LOGS_TAIL_MIN,
} from '@dwg/shared';
import { AppError } from '../../platform/errors.js';
import type { AuthMiddleware } from '../auth/auth.middleware.js';
import type { LogsService } from './logs.service.js';

export interface LogsRoutesDeps {
  readonly logsService: LogsService;
  readonly middleware: AuthMiddleware;
}

const ContainerLogsQuerySchema = z.object({
  tail: z.coerce.number().int().min(LOGS_TAIL_MIN).max(LOGS_TAIL_MAX).optional(),
  since: z.coerce.number().int().nonnegative().optional(),
  timestamps: z.coerce.boolean().optional(),
});

const LogFileQuerySchema = z.object({
  tail: z.coerce.number().int().min(LOGS_TAIL_MIN).max(LOGS_TAIL_MAX).optional(),
});

function parseQuery<Output>(schema: z.ZodType<Output>, query: unknown): Output {
  const result = schema.safeParse(query);
  if (!result.success) {
    throw new AppError('VALIDATION_FAILED', 'The request query parameters failed validation.', {
      details: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return result.data;
}

export async function registerLogsRoutes(
  app: FastifyInstance,
  deps: LogsRoutesDeps,
): Promise<void> {
  const { logsService, middleware } = deps;
  const { requireSession, requireCsrf, requirePermission } = middleware;

  await app.register(
    async (logsApp) => {
      logsApp.addHook('preHandler', requireSession());
      logsApp.addHook('preHandler', requireCsrf());
      logsApp.addHook('preHandler', requirePermission('docker:manage'));

      logsApp.get('/container', async (request, reply) => {
        const query = parseQuery(ContainerLogsQuerySchema, request.query);
        const lines = await logsService.containerLogs(query);
        void reply.send(ContainerLogsResponseSchema.parse({ lines }));
      });

      logsApp.get<{ Params: { source: string } }>('/file/:source', async (request, reply) => {
        const sourceResult = LogFileSourceSchema.safeParse(request.params.source);
        if (!sourceResult.success) {
          throw new AppError('VALIDATION_FAILED', 'source must be one of the supported log files.');
        }
        const query = parseQuery(LogFileQuerySchema, request.query);
        const lines = await logsService.file(sourceResult.data, query);
        void reply.send(LogsFileResponseSchema.parse({ lines }));
      });
    },
    { prefix: '/api/v1/docker/logs' },
  );
}
