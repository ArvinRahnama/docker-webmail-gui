/**
 * `/api/v1/security/dns/*` (FEATURE_MATRIX.md §10). Read-only diagnostics
 * — no mutation, so nothing here is audited (`platform/audit.ts`'s remit
 * is mutations). Rate-limited as its own encapsulated sub-scope, mirroring
 * `auth.routes.ts`'s `/login` throttle, because every route here drives a
 * live resolver call against an admin-supplied domain (SECURITY.md §3.4).
 */
import type { FastifyInstance } from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import {
  EmailAuthReportSchema,
  PropagationReportSchema,
  PROPAGATION_RECORD_TYPES,
} from '@dwg/shared';
import { AppError } from '../../platform/errors.js';
import type { AuthMiddleware } from '../auth/auth.middleware.js';
import type { DnsService } from './dns.service.js';

export interface DnsRoutesDeps {
  readonly dnsService: DnsService;
  readonly middleware: AuthMiddleware;
}

const DnsCheckQuerySchema = z.object({ selector: z.string().min(1).max(63).optional() });
const PropagationQuerySchema = z.object({
  recordType: z.enum(PROPAGATION_RECORD_TYPES),
  selector: z.string().min(1).max(63).optional(),
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

// Diagnostic re-checks are a click an admin can repeat, but each one is a
// live resolver round trip (possibly several, recursively, for SPF) —
// generous enough for normal use, tight enough to bound abuse
// (SECURITY.md §3.4: "rate-limited").
const DNS_RATE_LIMIT_MAX = 30;
const DNS_RATE_LIMIT_WINDOW = '1 minute';

export async function registerDnsRoutes(app: FastifyInstance, deps: DnsRoutesDeps): Promise<void> {
  const { dnsService, middleware } = deps;
  const { requireSession, requireCsrf, requirePermission } = middleware;

  await app.register(
    async (dnsApp) => {
      dnsApp.addHook('preHandler', requireSession());
      dnsApp.addHook('preHandler', requireCsrf());
      dnsApp.addHook('preHandler', requirePermission('security:manage'));

      await dnsApp.register(fastifyRateLimit, {
        max: DNS_RATE_LIMIT_MAX,
        timeWindow: DNS_RATE_LIMIT_WINDOW,
        errorResponseBuilder: () =>
          new AppError('RATE_LIMITED', 'Too many DNS checks. Try again in a minute.'),
      });

      dnsApp.get<{ Params: { domain: string } }>('/:domain', async (request, reply) => {
        const query = parseQuery(DnsCheckQuerySchema, request.query);
        const report = await dnsService.checkDomain(request.params.domain, query.selector);
        void reply.send(EmailAuthReportSchema.parse(report));
      });

      dnsApp.get<{ Params: { domain: string } }>('/:domain/propagation', async (request, reply) => {
        const query = parseQuery(PropagationQuerySchema, request.query);
        const report = await dnsService.checkPropagation(
          request.params.domain,
          query.recordType,
          query.selector,
        );
        void reply.send(PropagationReportSchema.parse(report));
      });
    },
    { prefix: '/api/v1/security/dns' },
  );
}
