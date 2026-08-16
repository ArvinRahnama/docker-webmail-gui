/**
 * `/api/v1/mailboxes/*` (FEATURE_MATRIX.md §3). Mirrors the auth module's
 * route/service shape: a thin HTTP layer over `MailboxesService` — parse
 * and validate with the shared Zod schema, call the service, audit,
 * respond. Delete is Tier 3 in the UI (UX_ARCHITECTURE.md §8); this layer
 * enforces its one hard rule — `mailData` is never optional, so there is
 * no code path here that can call `remove()` without an explicit
 * keep/delete choice (FEATURE_MATRIX.md §3's "always pass an explicit
 * flag" rule).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  BulkMailboxResponseSchema,
  BulkQuotaMailboxRequestSchema,
  BulkRestrictMailboxRequestSchema,
  ChangeMailboxPasswordRequestSchema,
  type ChangeMailboxPasswordResponse,
  ChangeMailboxPasswordResponseSchema,
  CreateMailboxRequestSchema,
  CreateMailboxResponseSchema,
  DeleteMailboxRequestSchema,
  MailboxDetailResponseSchema,
  MailboxListResponseSchema,
  RestrictMailboxRequestSchema,
  RestrictMailboxResponseSchema,
  SetMailboxQuotaRequestSchema,
  SetMailboxQuotaResponseSchema,
} from '@dwg/shared';
import { AppError } from '../../platform/errors.js';
import { recordAuditEvent } from '../../platform/audit.js';
import type { Database } from '../../platform/db.js';
import { requireAuthContext, type AuthMiddleware } from '../auth/auth.middleware.js';
import { parseBody } from '../auth/auth.routes.js';
import type { MailboxesService } from './mailboxes.service.js';

export interface MailboxesRoutesDeps {
  readonly db: Database;
  readonly mailboxesService: MailboxesService;
  readonly middleware: AuthMiddleware;
}

const MailboxListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
  domain: z.string().optional(),
  search: z.string().optional(),
  sortBy: z.enum(['email', 'domain', 'quota']).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
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

export async function registerMailboxesRoutes(
  app: FastifyInstance,
  deps: MailboxesRoutesDeps,
): Promise<void> {
  const { db, mailboxesService, middleware } = deps;
  const { requireSession, requireCsrf, requirePermission } = middleware;

  await app.register(
    async (mailboxesApp) => {
      mailboxesApp.addHook('preHandler', requireSession());
      mailboxesApp.addHook('preHandler', requireCsrf());
      mailboxesApp.addHook('preHandler', requirePermission('mail:manage'));

      mailboxesApp.get('/', async (request, reply) => {
        const query = parseQuery(MailboxListQuerySchema, request.query);
        const result = await mailboxesService.list(query);
        void reply.send(MailboxListResponseSchema.parse(result));
      });

      mailboxesApp.get<{ Params: { address: string } }>('/:address', async (request, reply) => {
        const detail = await mailboxesService.getDetail(request.params.address);
        if (!detail) {
          throw new AppError('NOT_FOUND', `No mailbox exists for ${request.params.address}.`);
        }
        void reply.send(MailboxDetailResponseSchema.parse(detail));
      });

      mailboxesApp.post('/', async (request, reply) => {
        const auth = requireAuthContext(request);
        const body = parseBody(CreateMailboxRequestSchema, request.body);

        const mailbox = await mailboxesService.create(body.email, body.password);

        recordAuditEvent(db, {
          actor: { adminId: auth.admin.id, label: auth.admin.email },
          action: 'mailbox.create',
          target: { type: 'mailbox', id: mailbox.email },
          result: 'success',
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          details: { email: mailbox.email },
        });

        reply.status(201);
        void reply.send(CreateMailboxResponseSchema.parse({ mailbox }));
      });

      mailboxesApp.patch<{ Params: { address: string } }>(
        '/:address/password',
        async (request, reply) => {
          const auth = requireAuthContext(request);
          const body = parseBody(ChangeMailboxPasswordRequestSchema, request.body);

          await mailboxesService.changePassword(request.params.address, body.password);

          recordAuditEvent(db, {
            actor: { adminId: auth.admin.id, label: auth.admin.email },
            action: 'mailbox.password_change',
            target: { type: 'mailbox', id: request.params.address },
            result: 'success',
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
            // Deliberately no `password`/`newPassword` key — see
            // platform/audit.ts's forbidden-key denylist, which would
            // refuse to write this row if one ever appeared here.
            details: { email: request.params.address },
          });

          const response: ChangeMailboxPasswordResponse = { changed: true };
          void reply.send(ChangeMailboxPasswordResponseSchema.parse(response));
        },
      );

      mailboxesApp.post<{ Params: { address: string } }>(
        '/:address/restrict',
        async (request, reply) => {
          const auth = requireAuthContext(request);
          const body = parseBody(RestrictMailboxRequestSchema, request.body);

          const mailbox = await mailboxesService.restrict(
            request.params.address,
            body.scope,
            body.restricted,
          );

          recordAuditEvent(db, {
            actor: { adminId: auth.admin.id, label: auth.admin.email },
            action: 'mailbox.restrict',
            target: { type: 'mailbox', id: mailbox.email },
            result: 'success',
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
            details: { email: mailbox.email, scope: body.scope, restricted: body.restricted },
          });

          void reply.send(RestrictMailboxResponseSchema.parse({ mailbox }));
        },
      );

      mailboxesApp.put<{ Params: { address: string } }>(
        '/:address/quota',
        async (request, reply) => {
          const auth = requireAuthContext(request);
          const body = parseBody(SetMailboxQuotaRequestSchema, request.body);

          const mailbox = await mailboxesService.setQuota(request.params.address, body.quota);

          recordAuditEvent(db, {
            actor: { adminId: auth.admin.id, label: auth.admin.email },
            action: 'mailbox.quota_set',
            target: { type: 'mailbox', id: mailbox.email },
            result: 'success',
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
            details: { email: mailbox.email, quota: body.quota },
          });

          void reply.send(SetMailboxQuotaResponseSchema.parse({ mailbox }));
        },
      );

      mailboxesApp.delete<{ Params: { address: string } }>(
        '/:address/quota',
        async (request, reply) => {
          const auth = requireAuthContext(request);

          const mailbox = await mailboxesService.clearQuota(request.params.address);

          recordAuditEvent(db, {
            actor: { adminId: auth.admin.id, label: auth.admin.email },
            action: 'mailbox.quota_clear',
            target: { type: 'mailbox', id: mailbox.email },
            result: 'success',
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
            details: { email: mailbox.email },
          });

          void reply.send(SetMailboxQuotaResponseSchema.parse({ mailbox }));
        },
      );

      mailboxesApp.delete<{ Params: { address: string } }>('/:address', async (request, reply) => {
        const auth = requireAuthContext(request);
        const body = parseBody(DeleteMailboxRequestSchema, request.body);

        const { mailbox, dependentAliases } = await mailboxesService.remove(
          request.params.address,
          body.mailData,
        );

        recordAuditEvent(db, {
          actor: { adminId: auth.admin.id, label: auth.admin.email },
          action: 'mailbox.delete',
          target: { type: 'mailbox', id: mailbox.email },
          result: 'success',
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          details: {
            email: mailbox.email,
            mailData: body.mailData,
            dependentAliasCount: dependentAliases.length,
          },
        });

        reply.status(204);
        void reply.send();
      });

      mailboxesApp.post('/bulk-restrict', async (request, reply) => {
        const auth = requireAuthContext(request);
        const body = parseBody(BulkRestrictMailboxRequestSchema, request.body);

        const results = await mailboxesService.bulkRestrict(
          body.addresses,
          body.scope,
          body.restricted,
        );

        recordAuditEvent(db, {
          actor: { adminId: auth.admin.id, label: auth.admin.email },
          action: 'mailbox.bulk_restrict',
          target: null,
          result: results.every((item) => item.ok) ? 'success' : 'failure',
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          details: {
            count: body.addresses.length,
            scope: body.scope,
            restricted: body.restricted,
            failureCount: results.filter((item) => !item.ok).length,
          },
        });

        void reply.send(BulkMailboxResponseSchema.parse({ results }));
      });

      mailboxesApp.post('/bulk-quota', async (request, reply) => {
        const auth = requireAuthContext(request);
        const body = parseBody(BulkQuotaMailboxRequestSchema, request.body);

        const results = await mailboxesService.bulkQuota(body.addresses, body.quota);

        recordAuditEvent(db, {
          actor: { adminId: auth.admin.id, label: auth.admin.email },
          action: 'mailbox.bulk_quota',
          target: null,
          result: results.every((item) => item.ok) ? 'success' : 'failure',
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          details: {
            count: body.addresses.length,
            quota: body.quota,
            failureCount: results.filter((item) => !item.ok).length,
          },
        });

        void reply.send(BulkMailboxResponseSchema.parse({ results }));
      });
    },
    { prefix: '/api/v1/mailboxes' },
  );
}
