/**
 * `/api/v1/backups/*` (M10 — IMPLEMENTATION_PLAN.md §2.1). Create/verify/
 * restore all enqueue a job and return its id immediately
 * (`BackupJobAckSchema`) — poll `GET /api/v1/jobs/:id` or stream
 * `GET /api/v1/jobs/:id/stream` for progress, matching every other
 * long-running operation in this codebase (ARCHITECTURE.md §7.5).
 *
 * Restore is Tier 4: `POST /:id/restore` requires the exact body
 * `RestoreBackupRequestSchema` demands (an explicit `confirm: true`, plus
 * `acknowledgeNoRecentBackup` whenever no recent verified backup exists)
 * and `BackupsService.restore` re-derives and refuses on the same
 * container-running/manifest-mismatch facts `GET /:id/restore/preflight`
 * reports — there is no way to skip straight to a restore a fresh
 * pre-flight would have refused.
 */
import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import {
  BackupDetailResponseSchema,
  BackupJobAckSchema,
  BackupListResponseSchema,
  CreateBackupRequestSchema,
  OperationAckSchema,
  RestoreBackupRequestSchema,
  RestorePreflightResponseSchema,
} from '@dwg/shared';
import { recordAuditEvent, type AuditAction } from '../../platform/audit.js';
import type { Database } from '../../platform/db.js';
import { requireAuthContext, type AuthMiddleware } from '../auth/auth.middleware.js';
import { parseBody } from '../auth/auth.routes.js';
import type { BackupsService } from './backups.service.js';

export interface BackupsRoutesDeps {
  readonly db: Database;
  readonly backupsService: BackupsService;
  readonly middleware: AuthMiddleware;
}

export async function registerBackupsRoutes(
  app: FastifyInstance,
  deps: BackupsRoutesDeps,
): Promise<void> {
  const { db, backupsService, middleware } = deps;
  const { requireSession, requireCsrf, requirePermission } = middleware;

  function audit(
    request: Parameters<typeof requireAuthContext>[0],
    action: AuditAction,
    targetId: string,
    details?: Record<string, string | number | boolean | null>,
  ): void {
    const auth = requireAuthContext(request);
    recordAuditEvent(db, {
      actor: { adminId: auth.admin.id, label: auth.admin.email },
      action,
      target: { type: 'backup', id: targetId },
      result: 'success',
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      ...(details !== undefined ? { details } : {}),
    });
  }

  await app.register(
    async (backupsApp) => {
      backupsApp.addHook('preHandler', requireSession());
      backupsApp.addHook('preHandler', requireCsrf());
      backupsApp.addHook('preHandler', requirePermission('maintenance:manage'));

      backupsApp.get('/', async (_request, reply) => {
        void reply.send(BackupListResponseSchema.parse({ backups: backupsService.list() }));
      });

      backupsApp.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
        void reply.send(
          BackupDetailResponseSchema.parse(backupsService.getDetail(request.params.id)),
        );
      });

      backupsApp.post('/', async (request, reply) => {
        const auth = requireAuthContext(request);
        const body = parseBody(CreateBackupRequestSchema, request.body);
        const job = backupsService.create(body.mode, {
          adminId: auth.admin.id,
          label: auth.admin.email,
        });
        audit(request, 'backup.create', job.id, { mode: body.mode });
        void reply.send(BackupJobAckSchema.parse({ jobId: job.id }));
      });

      backupsApp.post<{ Params: { id: string } }>('/:id/verify', async (request, reply) => {
        const auth = requireAuthContext(request);
        const job = backupsService.verify(request.params.id, {
          adminId: auth.admin.id,
          label: auth.admin.email,
        });
        audit(request, 'backup.verify', request.params.id, { jobId: job.id });
        void reply.send(BackupJobAckSchema.parse({ jobId: job.id }));
      });

      backupsApp.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
        await backupsService.delete(request.params.id);
        audit(request, 'backup.delete', request.params.id);
        void reply.send(OperationAckSchema.parse({ ok: true }));
      });

      backupsApp.get<{ Params: { id: string } }>('/:id/download', async (request, reply) => {
        const target = backupsService.getDownloadTarget(request.params.id);
        audit(request, 'backup.download', request.params.id);

        // Same hijack+raw-pipe technique as `platform/sse.ts` and the
        // broker's own `archive-routes.ts` — a backup archive is exactly
        // the kind of large, non-JSON body those two also stream this way.
        reply.hijack();
        reply.raw.writeHead(200, {
          'content-type': 'application/x-tar',
          'content-disposition': `attachment; filename="${target.fileName}"`,
        });
        const fileStream = createReadStream(target.filePath);
        fileStream.on('error', () => {
          reply.raw.destroy();
        });
        fileStream.pipe(reply.raw);
      });

      backupsApp.get<{ Params: { id: string } }>(
        '/:id/restore/preflight',
        async (request, reply) => {
          const preflight = await backupsService.preflight(request.params.id);
          void reply.send(RestorePreflightResponseSchema.parse(preflight));
        },
      );

      backupsApp.post<{ Params: { id: string } }>('/:id/restore', async (request, reply) => {
        const auth = requireAuthContext(request);
        const body = parseBody(RestoreBackupRequestSchema, request.body);
        const job = await backupsService.restore(request.params.id, body, {
          adminId: auth.admin.id,
          label: auth.admin.email,
        });
        audit(request, 'backup.restore', request.params.id, { jobId: job.id });
        void reply.send(BackupJobAckSchema.parse({ jobId: job.id }));
      });
    },
    { prefix: '/api/v1/backups' },
  );
}
