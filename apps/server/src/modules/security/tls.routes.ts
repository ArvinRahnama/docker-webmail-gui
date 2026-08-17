/**
 * `/api/v1/security/tls` (FEATURE_MATRIX.md §12). Read-only — no
 * mutation, so nothing here is audited. Rate-limited because each
 * request opens up to five real TCP connections out from the server
 * process (mirrors `dns.routes.ts`'s reasoning).
 */
import type { FastifyInstance } from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import { TlsStatusResponseSchema } from '@dwg/shared';
import { AppError } from '../../platform/errors.js';
import type { AuthMiddleware } from '../auth/auth.middleware.js';
import type { TlsService } from './tls.service.js';

export interface TlsRoutesDeps {
  readonly tlsService: TlsService;
  readonly middleware: AuthMiddleware;
}

const TLS_RATE_LIMIT_MAX = 20;
const TLS_RATE_LIMIT_WINDOW = '1 minute';

export async function registerTlsRoutes(app: FastifyInstance, deps: TlsRoutesDeps): Promise<void> {
  const { tlsService, middleware } = deps;
  const { requireSession, requireCsrf, requirePermission } = middleware;

  await app.register(
    async (tlsApp) => {
      tlsApp.addHook('preHandler', requireSession());
      tlsApp.addHook('preHandler', requireCsrf());
      tlsApp.addHook('preHandler', requirePermission('security:manage'));

      await tlsApp.register(fastifyRateLimit, {
        max: TLS_RATE_LIMIT_MAX,
        timeWindow: TLS_RATE_LIMIT_WINDOW,
        errorResponseBuilder: () =>
          new AppError('RATE_LIMITED', 'Too many TLS checks. Try again in a minute.'),
      });

      tlsApp.get('/', async (_request, reply) => {
        const status = await tlsService.getStatus();
        void reply.send(TlsStatusResponseSchema.parse(status));
      });
    },
    { prefix: '/api/v1/security/tls' },
  );
}
