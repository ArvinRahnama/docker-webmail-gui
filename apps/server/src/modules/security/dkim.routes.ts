/**
 * `/api/v1/security/dkim/*` (FEATURE_MATRIX.md §11). Status is a read;
 * generate/rotate is a mutation — `setup config dkim` — so it is audited
 * (`platform/audit.ts`) like every other DMS write in this codebase.
 * Rate-limited as its own encapsulated sub-scope for the same reason as
 * `dns.routes.ts`: status reads drive a live resolver call too.
 */
import type { FastifyInstance } from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { DkimStatusResponseSchema, GenerateDkimRequestSchema } from '@dwg/shared';
import { AppError } from '../../platform/errors.js';
import { recordAuditEvent } from '../../platform/audit.js';
import type { Database } from '../../platform/db.js';
import { requireAuthContext, type AuthMiddleware } from '../auth/auth.middleware.js';
import { parseBody } from '../auth/auth.routes.js';
import type { DkimService } from './dkim.service.js';

export interface DkimRoutesDeps {
  readonly db: Database;
  readonly dkimService: DkimService;
  readonly middleware: AuthMiddleware;
}

const DkimStatusQuerySchema = z.object({ selector: z.string().min(1).max(63).optional() });

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

const DKIM_RATE_LIMIT_MAX = 30;
const DKIM_RATE_LIMIT_WINDOW = '1 minute';

export async function registerDkimRoutes(
  app: FastifyInstance,
  deps: DkimRoutesDeps,
): Promise<void> {
  const { db, dkimService, middleware } = deps;
  const { requireSession, requireCsrf, requirePermission } = middleware;

  await app.register(
    async (dkimApp) => {
      dkimApp.addHook('preHandler', requireSession());
      dkimApp.addHook('preHandler', requireCsrf());
      dkimApp.addHook('preHandler', requirePermission('security:manage'));

      await dkimApp.register(fastifyRateLimit, {
        max: DKIM_RATE_LIMIT_MAX,
        timeWindow: DKIM_RATE_LIMIT_WINDOW,
        errorResponseBuilder: () =>
          new AppError('RATE_LIMITED', 'Too many DKIM checks. Try again in a minute.'),
      });

      dkimApp.get<{ Params: { domain: string } }>('/:domain', async (request, reply) => {
        const query = parseQuery(DkimStatusQuerySchema, request.query);
        const status = await dkimService.getStatus(request.params.domain, query.selector);
        void reply.send(DkimStatusResponseSchema.parse({ status }));
      });

      dkimApp.post<{ Params: { domain: string } }>('/:domain/generate', async (request, reply) => {
        const auth = requireAuthContext(request);
        const body = parseBody(GenerateDkimRequestSchema, request.body);

        const status = await dkimService.generate(request.params.domain, {
          ...(body.selector !== undefined ? { selector: body.selector } : {}),
          ...(body.keysize !== undefined ? { keysize: body.keysize } : {}),
        });

        recordAuditEvent(db, {
          actor: { adminId: auth.admin.id, label: auth.admin.email },
          action: 'dkim.generate',
          target: { type: 'domain', id: status.domain },
          result: 'success',
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          // Never the key material — only which domain/selector/keysize
          // were (re)generated (platform/audit.ts's own `details` rule).
          details: {
            domain: status.domain,
            selector: status.selector,
            keysize: body.keysize ?? null,
          },
        });

        void reply.send(DkimStatusResponseSchema.parse({ status }));
      });
    },
    { prefix: '/api/v1/security/dkim' },
  );
}
