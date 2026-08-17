/**
 * `/api/v1/security/rspamd/*` (FEATURE_MATRIX.md §13-15). Status/trend
 * are reads; the four write routes are the **entire** allowlist SECURITY.md
 * §3.13 permits — action threshold, symbol score, learn spam, learn ham —
 * each audited. There is no route here, and can never accidentally become
 * one, that accepts a raw Rspamd config document (`RspamdClientPort`'s own
 * closed method set, `drivers/rspamd/types.ts`, is what actually prevents
 * it).
 */
import type { FastifyInstance } from 'fastify';
import {
  RspamdLearnRequestSchema,
  RspamdStatusResponseSchema,
  RspamdTrendResponseSchema,
  RspamdWriteResponseSchema,
  SetRspamdActionThresholdRequestSchema,
  SetRspamdSymbolScoreRequestSchema,
} from '@dwg/shared';
import { recordAuditEvent } from '../../platform/audit.js';
import type { Database } from '../../platform/db.js';
import { requireAuthContext, type AuthMiddleware } from '../auth/auth.middleware.js';
import { parseBody } from '../auth/auth.routes.js';
import type { RspamdService } from './rspamd.service.js';

export interface RspamdRoutesDeps {
  readonly db: Database;
  readonly rspamdService: RspamdService;
  readonly middleware: AuthMiddleware;
}

export async function registerRspamdRoutes(
  app: FastifyInstance,
  deps: RspamdRoutesDeps,
): Promise<void> {
  const { db, rspamdService, middleware } = deps;
  const { requireSession, requireCsrf, requirePermission } = middleware;

  await app.register(
    async (rspamdApp) => {
      rspamdApp.addHook('preHandler', requireSession());
      rspamdApp.addHook('preHandler', requireCsrf());
      rspamdApp.addHook('preHandler', requirePermission('security:manage'));

      rspamdApp.get('/', async (_request, reply) => {
        const status = await rspamdService.getStatus();
        void reply.send(RspamdStatusResponseSchema.parse(status));
      });

      rspamdApp.get('/trend', async (_request, reply) => {
        const trend = await rspamdService.getTrend();
        void reply.send(RspamdTrendResponseSchema.parse(trend));
      });

      rspamdApp.post('/actions', async (request, reply) => {
        const auth = requireAuthContext(request);
        const body = parseBody(SetRspamdActionThresholdRequestSchema, request.body);

        await rspamdService.setActionThreshold(body.action, body.score);

        recordAuditEvent(db, {
          actor: { adminId: auth.admin.id, label: auth.admin.email },
          action: 'rspamd.threshold_set',
          target: { type: 'rspamd-action', id: body.action },
          result: 'success',
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          details: { action: body.action, score: body.score },
        });

        void reply.send(RspamdWriteResponseSchema.parse({ ok: true }));
      });

      rspamdApp.post('/symbols', async (request, reply) => {
        const auth = requireAuthContext(request);
        const body = parseBody(SetRspamdSymbolScoreRequestSchema, request.body);

        await rspamdService.setSymbolScore(body.symbol, body.score);

        recordAuditEvent(db, {
          actor: { adminId: auth.admin.id, label: auth.admin.email },
          action: 'rspamd.symbol_score_set',
          target: { type: 'rspamd-symbol', id: body.symbol },
          result: 'success',
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          details: { symbol: body.symbol, score: body.score },
        });

        void reply.send(RspamdWriteResponseSchema.parse({ ok: true }));
      });

      rspamdApp.post('/learn-spam', async (request, reply) => {
        const auth = requireAuthContext(request);
        const body = parseBody(RspamdLearnRequestSchema, request.body);

        await rspamdService.learnSpam(body.message);

        recordAuditEvent(db, {
          actor: { adminId: auth.admin.id, label: auth.admin.email },
          action: 'rspamd.learn_spam',
          target: null,
          result: 'success',
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          // Never the message body itself — only its length, which is
          // enough to audit "a learn action happened" without retaining
          // message content (which may include sender/recipient PII) in
          // the append-only log.
          details: { messageLength: body.message.length },
        });

        void reply.send(RspamdWriteResponseSchema.parse({ ok: true }));
      });

      rspamdApp.post('/learn-ham', async (request, reply) => {
        const auth = requireAuthContext(request);
        const body = parseBody(RspamdLearnRequestSchema, request.body);

        await rspamdService.learnHam(body.message);

        recordAuditEvent(db, {
          actor: { adminId: auth.admin.id, label: auth.admin.email },
          action: 'rspamd.learn_ham',
          target: null,
          result: 'success',
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          details: { messageLength: body.message.length },
        });

        void reply.send(RspamdWriteResponseSchema.parse({ ok: true }));
      });
    },
    { prefix: '/api/v1/security/rspamd' },
  );
}
