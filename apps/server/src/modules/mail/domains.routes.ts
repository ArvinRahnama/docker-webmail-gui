/**
 * `/api/v1/domains/*` — read-only (FEATURE_MATRIX.md §2; UX_ARCHITECTURE.md
 * §6.3).
 *
 * **This file deliberately registers only two `GET` routes.** docker-mailserver
 * has no `setup domain` command of any kind — a domain is not an object
 * that can be created, deleted or enabled/disabled, it is a computed view
 * over the domain-parts of addresses already in `postfix-accounts.cf` and
 * `postfix-virtual.cf` (`drivers/dms/domains.ts`). Adding a `POST`,
 * `PATCH` or `DELETE` handler here would be a control this API could
 * accept but the backend could never actually perform — exactly what
 * FEATURE_MATRIX.md's header rule forbids. `domains.routes.test.ts`
 * asserts no such route exists.
 */
import type { FastifyInstance } from 'fastify';
import { DomainDetailResponseSchema, DomainListResponseSchema } from '@dwg/shared';
import { AppError } from '../../platform/errors.js';
import type { AuthMiddleware } from '../auth/auth.middleware.js';
import type { DomainsService } from './domains.service.js';

export interface DomainsRoutesDeps {
  readonly domainsService: DomainsService;
  readonly middleware: AuthMiddleware;
}

export async function registerDomainsRoutes(
  app: FastifyInstance,
  deps: DomainsRoutesDeps,
): Promise<void> {
  const { domainsService, middleware } = deps;
  const { requireSession, requireCsrf, requirePermission } = middleware;

  await app.register(
    async (domainsApp) => {
      domainsApp.addHook('preHandler', requireSession());
      domainsApp.addHook('preHandler', requireCsrf());
      domainsApp.addHook('preHandler', requirePermission('mail:manage'));

      domainsApp.get('/', async (_request, reply) => {
        const domains = await domainsService.list();
        void reply.send(DomainListResponseSchema.parse({ domains }));
      });

      domainsApp.get<{ Params: { domain: string } }>('/:domain', async (request, reply) => {
        const detail = await domainsService.getDetail(request.params.domain);
        if (!detail) {
          throw new AppError('NOT_FOUND', `No domain "${request.params.domain}" was found.`);
        }
        void reply.send(DomainDetailResponseSchema.parse(detail));
      });
    },
    { prefix: '/api/v1/domains' },
  );
}
