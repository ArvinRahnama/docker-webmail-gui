/**
 * `/api/v1/updates/*` (M10 — IMPLEMENTATION_PLAN.md §2.2; SU-C for the
 * `/panel*` routes). `GET /` is a pure read (current vs available,
 * backup-gate facts, the rollback caveat — always present, per that
 * field's own schema comment). `POST /apply` always refuses with
 * `CAPABILITY_UNSUPPORTED` and audits the refusal — see
 * `updates.service.ts`'s header for exactly why apply is deferred, not
 * merely unimplemented-and-silent. Both are the docker-mailserver
 * comparison (owner §9.3: this card stays, untouched by SU-C).
 *
 * `/panel*` is the separate, genuinely-actionable panel self-update
 * surface (`panel-self-update.service.ts`) — same prefix, same
 * `requirePermission('maintenance:manage')` gate, registered in this
 * same plugin rather than a second one. `GET /panel` reports
 * current/latest/possible (auto-latest, §9.1 — the client never chooses
 * a version). `POST /panel/apply` enqueues the job and audits
 * `update.self_update_started` immediately; the job's own SSE stream
 * (`GET /api/v1/jobs/:id/stream`, already generic) covers progress.
 * `GET /panel/last-result` is the read-and-clear status-file endpoint
 * (§5) — the *only* place the real success/rolled-back/failed verdict is
 * discovered, and where the corresponding `update.self_update_*` audit
 * row is written (§7) — never sourced from the job's own terminal status
 * (`panel-self-update.service.ts`'s header explains why, at length).
 */
import type { FastifyInstance } from 'fastify';
import {
  PanelUpdateApplyAckSchema,
  PanelUpdateCheckResponseSchema,
  SelfUpdateLastResultResponseSchema,
  UpdateStatusResponseSchema,
} from '@dwg/shared';
import { recordAuditEvent, type AuditAction } from '../../platform/audit.js';
import type { Database } from '../../platform/db.js';
import { requireAuthContext, type AuthMiddleware } from '../auth/auth.middleware.js';
import type { PanelSelfUpdateService } from './panel-self-update.service.js';
import type { UpdatesService } from './updates.service.js';

export interface UpdatesRoutesDeps {
  readonly db: Database;
  readonly updatesService: UpdatesService;
  readonly panelSelfUpdateService: PanelSelfUpdateService;
  readonly middleware: AuthMiddleware;
}

/** The `update.self_update_*` action matching a discovered verdict — see this file's header on why this mapping lives at the route, next to the one place the verdict is discovered at all. */
function auditActionForOutcome(outcome: 'success' | 'rolled-back' | 'failed'): AuditAction {
  switch (outcome) {
    case 'success':
      return 'update.self_update_succeeded';
    case 'rolled-back':
      return 'update.self_update_rolled_back';
    case 'failed':
      return 'update.self_update_failed';
  }
}

export async function registerUpdatesRoutes(
  app: FastifyInstance,
  deps: UpdatesRoutesDeps,
): Promise<void> {
  const { db, updatesService, panelSelfUpdateService, middleware } = deps;
  const { requireSession, requireCsrf, requirePermission } = middleware;

  await app.register(
    async (updatesApp) => {
      updatesApp.addHook('preHandler', requireSession());
      updatesApp.addHook('preHandler', requireCsrf());
      updatesApp.addHook('preHandler', requirePermission('maintenance:manage'));

      updatesApp.get('/', async (_request, reply) => {
        const status = await updatesService.getStatus();
        void reply.send(UpdateStatusResponseSchema.parse(status));
      });

      updatesApp.post('/apply', async (request) => {
        const auth = requireAuthContext(request);
        recordAuditEvent(db, {
          actor: { adminId: auth.admin.id, label: auth.admin.email },
          action: 'update.apply_refused',
          target: null,
          result: 'success',
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });
        // Always throws — see `UpdatesService.applyRefused`'s doc
        // comment. The uniform error handler turns this into a
        // `CAPABILITY_UNSUPPORTED` response; there is no reply to send
        // on the success path because there is no success path.
        updatesService.applyRefused();
      });

      updatesApp.get('/panel', async (_request, reply) => {
        const status = await panelSelfUpdateService.getStatus();
        void reply.send(PanelUpdateCheckResponseSchema.parse(status));
      });

      updatesApp.post('/panel/apply', async (request, reply) => {
        const auth = requireAuthContext(request);
        const { job, targetVersion } = await panelSelfUpdateService.apply({
          adminId: auth.admin.id,
          label: auth.admin.email,
        });
        recordAuditEvent(db, {
          actor: { adminId: auth.admin.id, label: auth.admin.email },
          action: 'update.self_update_started',
          target: null,
          result: 'success',
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          details: { jobId: job.id, targetVersion },
        });
        void reply.send(PanelUpdateApplyAckSchema.parse({ jobId: job.id }));
      });

      updatesApp.get('/panel/last-result', async (request, reply) => {
        const auth = requireAuthContext(request);
        const result = await panelSelfUpdateService.readLastResult();
        if (result !== null) {
          recordAuditEvent(db, {
            actor: { adminId: auth.admin.id, label: auth.admin.email },
            action: auditActionForOutcome(result.outcome),
            target: null,
            result: result.outcome === 'failed' ? 'failure' : 'success',
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
            details: {
              fromVersion: result.fromVersion,
              toVersion: result.toVersion,
              reason: result.reason,
            },
          });
        }
        void reply.send(SelfUpdateLastResultResponseSchema.parse({ result }));
      });
    },
    { prefix: '/api/v1/updates' },
  );
}
