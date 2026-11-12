/**
 * `/api/v1/security/spam-filter/*` — per-mailbox sender lists, the user
 * reports that maintain them, and the list of rejected mail
 * (docker/dms/README.md). Reads and writes alike sit behind
 * `security:manage`, matching every other security page. List edits are
 * audited with the entry itself (an address, domain or IP — not secret);
 * automatic changes from user reports are audited by
 * `sender-report-collector.ts`.
 */
import type { FastifyInstance } from 'fastify';
import {
  AddSenderListEntryRequestSchema,
  RejectedMailResponseSchema,
  RemoveSenderListEntryRequestSchema,
  SenderListsResponseSchema,
  SenderReportsResponseSchema,
  SpamIntegrationResponseSchema,
  validateAddressForArgv,
} from '@dwg/shared';
import { recordAuditEvent } from '../../platform/audit.js';
import type { Database } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import { requireAuthContext, type AuthMiddleware } from '../auth/auth.middleware.js';
import { parseBody } from '../auth/auth.routes.js';
import type { RejectedMailService } from './rejected-mail.service.js';
import type { SenderListsService } from './sender-lists.service.js';

export interface SpamFilterRoutesDeps {
  readonly db: Database;
  readonly senderListsService: SenderListsService;
  readonly rejectedMailService: RejectedMailService;
  readonly middleware: AuthMiddleware;
}

function mailboxParam(raw: string): string {
  const mailbox = raw.trim().toLowerCase();
  const error = validateAddressForArgv(mailbox);
  if (error !== null) throw new AppError('VALIDATION_FAILED', error);
  return mailbox;
}

export async function registerSpamFilterRoutes(
  app: FastifyInstance,
  deps: SpamFilterRoutesDeps,
): Promise<void> {
  const { db, senderListsService, rejectedMailService, middleware } = deps;
  const { requireSession, requireCsrf, requirePermission } = middleware;

  await app.register(
    async (spamApp) => {
      spamApp.addHook('preHandler', requireSession());
      spamApp.addHook('preHandler', requireCsrf());
      spamApp.addHook('preHandler', requirePermission('security:manage'));

      spamApp.get('/integration', async (_request, reply) => {
        const integration = await senderListsService.integration();
        void reply.send(SpamIntegrationResponseSchema.parse({ integration }));
      });

      spamApp.get('/rejected', async (_request, reply) => {
        void reply.send(RejectedMailResponseSchema.parse(await rejectedMailService.list()));
      });

      spamApp.get<{ Querystring: { mailbox?: string } }>('/reports', async (request, reply) => {
        const raw = request.query.mailbox;
        const mailbox = raw === undefined || raw.length === 0 ? null : mailboxParam(raw);
        const reports = senderListsService.listReports(mailbox);
        void reply.send(SenderReportsResponseSchema.parse({ reports }));
      });

      spamApp.get<{ Params: { mailbox: string } }>(
        '/sender-lists/:mailbox',
        async (request, reply) => {
          const mailbox = mailboxParam(request.params.mailbox);
          void reply.send(SenderListsResponseSchema.parse(await senderListsService.get(mailbox)));
        },
      );

      spamApp.post<{ Params: { mailbox: string } }>(
        '/sender-lists/:mailbox',
        async (request, reply) => {
          const auth = requireAuthContext(request);
          const mailbox = mailboxParam(request.params.mailbox);
          const body = parseBody(AddSenderListEntryRequestSchema, request.body);
          const result = await senderListsService.add(mailbox, body);
          recordAuditEvent(db, {
            actor: { adminId: auth.admin.id, label: auth.admin.email },
            action: 'sender_list.add',
            target: { type: 'mailbox', id: mailbox },
            result: 'success',
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
            details: { list: body.list, kind: body.kind, value: body.value },
          });
          void reply.send(SenderListsResponseSchema.parse(result));
        },
      );

      spamApp.post<{ Params: { mailbox: string } }>(
        '/sender-lists/:mailbox/remove',
        async (request, reply) => {
          const auth = requireAuthContext(request);
          const mailbox = mailboxParam(request.params.mailbox);
          const body = parseBody(RemoveSenderListEntryRequestSchema, request.body);
          const result = await senderListsService.remove(mailbox, body);
          recordAuditEvent(db, {
            actor: { adminId: auth.admin.id, label: auth.admin.email },
            action: 'sender_list.remove',
            target: { type: 'mailbox', id: mailbox },
            result: 'success',
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
            details: { list: body.list, kind: body.kind, value: body.value },
          });
          void reply.send(SenderListsResponseSchema.parse(result));
        },
      );
    },
    { prefix: '/api/v1/security/spam-filter' },
  );
}
