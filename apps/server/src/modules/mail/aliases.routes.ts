/**
 * `/api/v1/aliases/*` — one page, one API, for both aliases and
 * forwarding (FEATURE_MATRIX.md §4, §5). `:id` is the alias's own address
 * (URL-decoded automatically by Fastify's router — `@dwg/shared`'s
 * `AliasSummarySchema` doc comment on `id`), never a synthesised value.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AliasListResponseSchema,
  ALIAS_TYPES,
  CreateAliasRequestSchema,
  CreateAliasResponseSchema,
  UpdateAliasRequestSchema,
  UpdateAliasResponseSchema,
} from '@dwg/shared';
import { AppError } from '../../platform/errors.js';
import { recordAuditEvent } from '../../platform/audit.js';
import type { Database } from '../../platform/db.js';
import { requireAuthContext, type AuthMiddleware } from '../auth/auth.middleware.js';
import { parseBody } from '../auth/auth.routes.js';
import type { AliasesService } from './aliases.service.js';

export interface AliasesRoutesDeps {
  readonly db: Database;
  readonly aliasesService: AliasesService;
  readonly middleware: AuthMiddleware;
}

const AliasListQuerySchema = z.object({
  domain: z.string().optional(),
  search: z.string().optional(),
  type: z.enum(ALIAS_TYPES).optional(),
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

export async function registerAliasesRoutes(
  app: FastifyInstance,
  deps: AliasesRoutesDeps,
): Promise<void> {
  const { db, aliasesService, middleware } = deps;
  const { requireSession, requireCsrf, requirePermission } = middleware;

  await app.register(
    async (aliasesApp) => {
      aliasesApp.addHook('preHandler', requireSession());
      aliasesApp.addHook('preHandler', requireCsrf());
      aliasesApp.addHook('preHandler', requirePermission('mail:manage'));

      aliasesApp.get('/', async (request, reply) => {
        const query = parseQuery(AliasListQuerySchema, request.query);
        const result = await aliasesService.list(query);
        void reply.send(AliasListResponseSchema.parse(result));
      });

      aliasesApp.post('/', async (request, reply) => {
        const auth = requireAuthContext(request);
        const body = parseBody(CreateAliasRequestSchema, request.body);

        const alias = await aliasesService.create(body.alias, body.recipients);

        recordAuditEvent(db, {
          actor: { adminId: auth.admin.id, label: auth.admin.email },
          action: 'alias.create',
          target: { type: 'alias', id: alias.address },
          result: 'success',
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          details: { address: alias.address, recipientCount: alias.recipients.length },
        });

        reply.status(201);
        void reply.send(CreateAliasResponseSchema.parse({ alias }));
      });

      aliasesApp.put<{ Params: { id: string } }>('/:id', async (request, reply) => {
        const auth = requireAuthContext(request);
        const body = parseBody(UpdateAliasRequestSchema, request.body);

        const alias = await aliasesService.update(request.params.id, body.recipients);

        recordAuditEvent(db, {
          actor: { adminId: auth.admin.id, label: auth.admin.email },
          action: 'alias.update',
          target: { type: 'alias', id: alias.address },
          result: 'success',
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          details: { address: alias.address, recipientCount: alias.recipients.length },
        });

        void reply.send(UpdateAliasResponseSchema.parse({ alias }));
      });

      aliasesApp.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
        const auth = requireAuthContext(request);

        const removed = await aliasesService.remove(request.params.id);

        recordAuditEvent(db, {
          actor: { adminId: auth.admin.id, label: auth.admin.email },
          action: 'alias.delete',
          target: { type: 'alias', id: removed.address },
          result: 'success',
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          details: { address: removed.address, recipientCount: removed.recipients.length },
        });

        reply.status(204);
        void reply.send();
      });
    },
    { prefix: '/api/v1/aliases' },
  );
}
