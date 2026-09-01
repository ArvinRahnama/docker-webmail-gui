/**
 * `/api/v1/backups/*` automation surface (M13) — scheduled backups, the remote
 * destination config, per-backup upload/retry, remote browse, and
 * restore-from-remote import. Registered as its own plugin alongside
 * `backups.routes.ts` under the same prefix; the static paths here
 * (`/schedule`, `/destination/*`, `/remote`, `/reconcile`) never collide with
 * that file's `/:id` routes.
 *
 * Long-running work (upload, import, reconcile) is enqueued as a job and the
 * route returns the job id immediately, exactly like create/verify/restore.
 *
 * Guardrail: every selector a client supplies is symbolic — a backup id, a
 * none/s3 destination choice, or a backup id that must match a key the
 * server's own `list()` returns. No path, URL, bucket or host from the client
 * reaches the filesystem, the Docker API, or an arbitrary remote; the web tier
 * picks from what the server offers.
 */
import type { FastifyInstance } from 'fastify';
import {
  BackupDestinationSecretResponseSchema,
  BackupDestinationStatusResponseSchema,
  BackupDestinationUpdateSchema,
  BackupImportRequestSchema,
  BackupJobAckSchema,
  BackupScheduleResponseSchema,
  BackupScheduleUpdateSchema,
  OperationAckSchema,
  RemoteBackupListResponseSchema,
} from '@dwg/shared';
import { recordAuditEvent } from '../../platform/audit.js';
import type { Database } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import type { JobRunner } from '../../platform/jobs/job-runner.js';
import { requireAuthContext, type AuthMiddleware } from '../auth/auth.middleware.js';
import { parseBody } from '../auth/auth.routes.js';
import type { BackupScheduleService } from './backup-schedule.service.js';
import type { BackupUploader } from './backup-uploader.js';
import type { BackupDestinationConfigService } from './backup-destination-config.service.js';
import type { BackupsRepository } from './backups.repository.js';
import { backupIdFromKey } from './destinations/destination.js';
import type { DestinationService } from './destinations/destination.service.js';

export interface BackupsAutomationRoutesDeps {
  readonly db: Database;
  readonly scheduleService: BackupScheduleService;
  readonly destinationConfigService: BackupDestinationConfigService;
  readonly destinationService: DestinationService;
  readonly uploader: BackupUploader;
  readonly backupsRepository: BackupsRepository;
  readonly jobRunner: JobRunner;
  readonly middleware: AuthMiddleware;
}

export async function registerBackupsAutomationRoutes(
  app: FastifyInstance,
  deps: BackupsAutomationRoutesDeps,
): Promise<void> {
  const {
    db,
    scheduleService,
    destinationConfigService,
    destinationService,
    uploader,
    backupsRepository,
    jobRunner,
    middleware,
  } = deps;
  const { requireSession, requireCsrf, requirePermission } = middleware;

  await app.register(
    async (automationApp) => {
      automationApp.addHook('preHandler', requireSession());
      automationApp.addHook('preHandler', requireCsrf());
      automationApp.addHook('preHandler', requirePermission('maintenance:manage'));

      // --- Schedule ---------------------------------------------------------

      automationApp.get('/schedule', (_request, reply) => {
        void reply.send(BackupScheduleResponseSchema.parse({ schedule: scheduleService.get() }));
      });

      automationApp.put('/schedule', (request, reply) => {
        const auth = requireAuthContext(request);
        const body = parseBody(BackupScheduleUpdateSchema, request.body);
        const schedule = scheduleService.update(body);
        recordAuditEvent(db, {
          actor: { adminId: auth.admin.id, label: auth.admin.email },
          action: 'config.apply',
          target: { type: 'config', id: 'backup_schedule' },
          result: 'success',
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          details: { setting: 'backup_schedule', frequency: body.frequency },
        });
        void reply.send(BackupScheduleResponseSchema.parse({ schedule }));
      });

      // --- Destination config ----------------------------------------------

      automationApp.get('/destination', (_request, reply) => {
        void reply.send(
          BackupDestinationStatusResponseSchema.parse({
            destination: destinationConfigService.getStatus(),
          }),
        );
      });

      automationApp.put('/destination', (request, reply) => {
        const auth = requireAuthContext(request);
        const body = parseBody(BackupDestinationUpdateSchema, request.body);
        // The service audits (config.apply) and takes the pre-change snapshot.
        destinationConfigService.update(body, {
          adminId: auth.admin.id,
          label: auth.admin.email,
        });

        // Reconnecting a destination while auto-upload is on: sweep any local
        // backlog straight away rather than waiting for the periodic timer.
        if (destinationService.current() !== null && scheduleService.get().uploadToRemote) {
          jobRunner.enqueue({
            type: 'backup.upload',
            createdByAdminId: auth.admin.id,
            createdByLabel: auth.admin.email,
            metadata: { reconcile: true },
            execute: () =>
              uploader
                .reconcile({ adminId: auth.admin.id, label: auth.admin.email })
                .then((summary) => ({ ...summary })),
          });
        }

        void reply.send(
          BackupDestinationStatusResponseSchema.parse({
            destination: destinationConfigService.getStatus(),
          }),
        );
      });

      automationApp.post('/destination/test', async (_request, reply) => {
        await destinationService.testConnection();
        void reply.send(OperationAckSchema.parse({ ok: true }));
      });

      automationApp.post('/destination/reveal-secret', (request, reply) => {
        const auth = requireAuthContext(request);
        // The service audits this as a secret reveal.
        const revealed = destinationConfigService.revealSecret({
          adminId: auth.admin.id,
          label: auth.admin.email,
        });
        void reply.send(BackupDestinationSecretResponseSchema.parse(revealed));
      });

      // --- Per-backup upload / retry ---------------------------------------

      automationApp.post<{ Params: { id: string } }>('/:id/upload', (request, reply) => {
        const auth = requireAuthContext(request);
        const { id } = request.params;
        if (backupsRepository.getRowById(id) === null) {
          throw new AppError('NOT_FOUND', `No backup with id ${id}.`);
        }
        const actor = { adminId: auth.admin.id, label: auth.admin.email };
        const job = jobRunner.enqueue({
          type: 'backup.upload',
          createdByAdminId: actor.adminId,
          createdByLabel: actor.label,
          metadata: { backupId: id },
          execute: () =>
            uploader.uploadBackup(id, actor).then((outcome) => ({ backupId: id, ...outcome })),
        });
        void reply.send(BackupJobAckSchema.parse({ jobId: job.id }));
      });

      // --- Reconcile now ----------------------------------------------------

      automationApp.post('/reconcile', (request, reply) => {
        const auth = requireAuthContext(request);
        const actor = { adminId: auth.admin.id, label: auth.admin.email };
        const job = jobRunner.enqueue({
          type: 'backup.upload',
          createdByAdminId: actor.adminId,
          createdByLabel: actor.label,
          metadata: { reconcile: true },
          execute: () => uploader.reconcile(actor).then((summary) => ({ ...summary })),
        });
        void reply.send(BackupJobAckSchema.parse({ jobId: job.id }));
      });

      // --- Remote browse + import ------------------------------------------

      automationApp.get('/remote', async (_request, reply) => {
        const destination = destinationService.current();
        if (destination === null) {
          throw new AppError('CONFLICT', 'No remote destination is configured.');
        }
        const remote = await destination.list();
        const backups = remote.flatMap((item) => {
          const backupId = backupIdFromKey(item.key);
          if (backupId === null) return [];
          return [
            {
              backupId,
              key: item.key,
              sizeBytes: item.sizeBytes,
              lastModified: item.lastModified,
              alreadyLocal: (backupsRepository.getRowById(backupId)?.local_present ?? 0) === 1,
            },
          ];
        });
        void reply.send(RemoteBackupListResponseSchema.parse({ backups }));
      });

      automationApp.post('/remote/import', (request, reply) => {
        const auth = requireAuthContext(request);
        const body = parseBody(BackupImportRequestSchema, request.body);
        const job = jobRunner.enqueue({
          type: 'backup.import',
          createdByAdminId: auth.admin.id,
          createdByLabel: auth.admin.email,
          metadata: { backupId: body.backupId },
          execute: () =>
            uploader.importFromRemote(body.backupId).then((outcome) => ({
              backupId: body.backupId,
              ...outcome,
            })),
        });
        void reply.send(BackupJobAckSchema.parse({ jobId: job.id }));
      });
    },
    { prefix: '/api/v1/backups' },
  );
}
