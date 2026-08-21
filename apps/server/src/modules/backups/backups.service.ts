/**
 * Orchestrates M10 backups and restore (IMPLEMENTATION_PLAN.md §2.1) on
 * top of `backup-archive.ts`'s pure archive logic, `BackupsRepository`'s
 * persistence and the shared `JobRunner`. Every long-running operation
 * here (create/verify/restore) enqueues a job and returns immediately —
 * this service never awaits archive work itself, matching
 * ARCHITECTURE.md §7.5.
 *
 * **Restore's refusals are enforced here, before a job is ever enqueued**
 * (IMPLEMENTATION_PLAN.md §2.1: "refuses with an explanation rather than
 * proceeding hopefully") — container-running and manifest-digest
 * incompatibility are never something the *job* discovers partway
 * through; `restore()` re-derives the exact same pre-flight facts
 * `preflight()` reports and refuses on either before touching anything.
 */
import { join } from 'node:path';
import { rm, unlink } from 'node:fs/promises';
import type {
  BackupDetailResponse,
  BackupMode,
  BackupSummary,
  Job,
  RestoreBackupRequest,
  RestorePreflightResponse,
} from '@dwg/shared';
import type { BrokerClient } from '../../drivers/broker/types.js';
import { AppError, generateId } from '../../platform/errors.js';
import type { JobContext } from '../../platform/jobs/job-runner.js';
import type { JobRunner } from '../../platform/jobs/job-runner.js';
import {
  createBackupArchive,
  extractBackupArchiveForRestore,
  restoreVolumesFromExtractedArchive,
  verifyBackupArchive,
} from './backup-archive.js';
import type { BackupsRepository } from './backups.repository.js';

export interface BackupActor {
  readonly adminId: string | null;
  readonly label: string;
}

/** Static, always-present reminder surfaced in the pre-flight report itself — IMPLEMENTATION_PLAN.md §2.1's "documented gotcha that silently breaks mail delivery when missed" is not left to documentation an admin may never open. */
const VMAIL_OWNERSHIP_NOTE =
  'This restore preserves the original uid/gid of every file exactly as the backup recorded it — including the vmail account (5000:5000 by default). Nothing in this process re-chowns extracted files; if a deployment stores mail under a non-default vmail uid/gid, that ownership is exactly what gets restored.';

function buildCompatibilityMessage(
  manifestDigest: string | null,
  currentDigest: string | null,
): string {
  if (manifestDigest === null || currentDigest === null) {
    return 'The backup image digest or the running image digest could not be confirmed, so compatibility cannot be verified. Refusing rather than proceeding hopefully.';
  }
  return `This backup was taken from DMS image ${manifestDigest}; the running container is ${currentDigest}. Restoring across a different image is refused — see the update rollback caveat for why DMS state is not safely portable across versions.`;
}

export class BackupsService {
  constructor(
    private readonly repository: BackupsRepository,
    private readonly jobRunner: JobRunner,
    private readonly broker: BrokerClient,
    private readonly backupDir: string,
  ) {}

  list(): readonly BackupSummary[] {
    return this.repository.list();
  }

  getDetail(id: string): BackupDetailResponse {
    const backup = this.repository.getSummaryById(id);
    const manifest = this.repository.getManifestById(id);
    if (backup === null || manifest === null) {
      throw new AppError('NOT_FOUND', `No backup with id ${id}.`);
    }
    return { backup, manifest };
  }

  /** Location + size for the download route to stream — internal only, never echoed to a client as JSON (SECURITY.md §3.10: backups are addressed by opaque id, never a path). */
  getDownloadTarget(id: string): { readonly filePath: string; readonly fileName: string } {
    const row = this.repository.getRowById(id);
    if (row === null) {
      throw new AppError('NOT_FOUND', `No backup with id ${id}.`);
    }
    return { filePath: row.file_path, fileName: `${id}.tar` };
  }

  async delete(id: string): Promise<void> {
    const row = this.repository.getRowById(id);
    if (row === null) {
      throw new AppError('NOT_FOUND', `No backup with id ${id}.`);
    }
    this.repository.delete(id);
    await unlink(row.file_path).catch(() => {
      // The DB row is the source of truth for "does this backup exist";
      // a file already missing from disk (manually removed, a prior
      // partial cleanup) must not block deleting the row that referenced
      // it.
    });
  }

  create(mode: BackupMode, actor: BackupActor): Job {
    const backupId = generateId('bkp');

    return this.jobRunner.enqueue({
      type: 'backup.create',
      createdByAdminId: actor.adminId,
      createdByLabel: actor.label,
      metadata: { mode },
      execute: (ctx) => this.performCreate(backupId, mode, actor, ctx),
    });
  }

  private async performCreate(
    backupId: string,
    mode: BackupMode,
    actor: BackupActor,
    ctx: JobContext,
  ) {
    let dmsImageDigest: string | null = null;
    try {
      const inspection = await this.broker.containerInspect();
      dmsImageDigest = inspection.image;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log(
        'warn',
        `Could not resolve the running DMS image digest (${message}); the manifest will record it as unknown.`,
      );
    }

    if (mode === 'cold') {
      ctx.log('info', 'Cold backup: stopping the managed container for a consistent archive...');
      await this.broker.containerStop();
    } else {
      ctx.log(
        'warn',
        'Warm backup: mail data is live during archiving. Entries may reflect an in-progress state — this is expected, not an error.',
      );
    }

    try {
      const created = await createBackupArchive(
        {
          broker: this.broker,
          backupDir: this.backupDir,
          backupId,
          mode,
          createdBy: { adminId: actor.adminId, label: actor.label },
          dmsImageDigest,
        },
        ctx,
      );

      this.repository.insert({
        id: backupId,
        createdByAdminId: actor.adminId,
        filePath: created.filePath,
        sizeBytes: created.sizeBytes,
        checksum: created.checksumSha256,
        manifest: created.manifest,
      });

      return { backupId, mode, sizeBytes: created.sizeBytes };
    } finally {
      if (mode === 'cold') {
        ctx.log('info', 'Cold backup: restarting the managed container...');
        await this.broker.containerStart();
      }
    }
  }

  verify(id: string, actor: BackupActor): Job {
    const row = this.repository.getRowById(id);
    const manifest = this.repository.getManifestById(id);
    if (row === null || manifest === null) {
      throw new AppError('NOT_FOUND', `No backup with id ${id}.`);
    }

    return this.jobRunner.enqueue({
      type: 'backup.verify',
      createdByAdminId: actor.adminId,
      createdByLabel: actor.label,
      metadata: { backupId: id },
      execute: async (ctx) => {
        ctx.log(
          'info',
          'Recomputing checksums and validating archive structure (no extraction)...',
        );
        ctx.setProgress(20);
        const result = await verifyBackupArchive(row.file_path, manifest);
        ctx.setProgress(90);

        if (result.ok) {
          this.repository.markVerified(id, new Date().toISOString());
          ctx.log('info', 'Verification succeeded: checksums and structure match the manifest.');
        } else {
          this.repository.markVerificationFailed(id);
          ctx.log('error', `Verification failed: ${result.reason ?? 'unknown reason'}`);
        }
        ctx.setProgress(100);
        return { backupId: id, verified: result.ok, reason: result.reason };
      },
    });
  }

  /** Pure read — safe to call as often as the UI wants (e.g. before rendering the Tier 4 confirm dialog). Every fact `restore()` refuses on is computed here first, so the two never disagree. */
  async preflight(id: string): Promise<RestorePreflightResponse> {
    const backup = this.repository.getSummaryById(id);
    const manifest = this.repository.getManifestById(id);
    if (backup === null || manifest === null) {
      throw new AppError('NOT_FOUND', `No backup with id ${id}.`);
    }

    const inspection = await this.broker.containerInspect();
    const currentDmsImageDigest = inspection.image;
    const manifestCompatible =
      manifest.dmsImageDigest !== null &&
      currentDmsImageDigest !== null &&
      manifest.dmsImageDigest === currentDmsImageDigest;

    const mostRecentVerified = this.repository.mostRecentVerified();

    return {
      backup,
      containerRunning: inspection.state.running,
      currentDmsImageDigest,
      manifestCompatible,
      compatibilityMessage: manifestCompatible
        ? null
        : buildCompatibilityMessage(manifest.dmsImageDigest, currentDmsImageDigest),
      recentVerifiedBackupExists: mostRecentVerified !== null,
      mostRecentVerifiedBackupAt: mostRecentVerified?.verifiedAt ?? null,
      vmailOwnershipNote: VMAIL_OWNERSHIP_NOTE,
    };
  }

  async restore(id: string, request: RestoreBackupRequest, actor: BackupActor): Promise<Job> {
    const preflight = await this.preflight(id);

    // Container-stopped and manifest-compatibility are *not*
    // acknowledgeable — refused outright, matching
    // IMPLEMENTATION_PLAN.md §2.1 exactly ("refuses with an explanation
    // rather than proceeding hopefully"). Only the backup-gate
    // (no-recent-verified-backup) accepts an explicit acknowledgement.
    if (preflight.containerRunning) {
      throw new AppError(
        'CONFLICT',
        'The managed container must be stopped before a restore can proceed.',
      );
    }
    if (!preflight.manifestCompatible) {
      throw new AppError(
        'CONFLICT',
        preflight.compatibilityMessage ??
          'This backup is not compatible with the running DMS image.',
      );
    }
    if (!preflight.recentVerifiedBackupExists && !request.acknowledgeNoRecentBackup) {
      throw new AppError(
        'VALIDATION_FAILED',
        'No recent verified backup of the current data exists. Acknowledge this explicitly to proceed.',
      );
    }

    const row = this.repository.getRowById(id);
    if (row === null) {
      throw new AppError('NOT_FOUND', `No backup with id ${id}.`);
    }
    const manifest = this.repository.getManifestById(id);
    if (manifest === null) {
      throw new AppError('NOT_FOUND', `No backup with id ${id}.`);
    }

    return this.jobRunner.enqueue({
      type: 'backup.restore',
      createdByAdminId: actor.adminId,
      createdByLabel: actor.label,
      metadata: { backupId: id },
      execute: (ctx) => this.performRestore(id, row.file_path, ctx),
    });
  }

  private async performRestore(id: string, filePath: string, ctx: JobContext) {
    // Defense in depth: `restore()` above already refused a running
    // container before this job was ever enqueued, but state can change
    // between "enqueued" and "this job actually starts" (another admin
    // starts the container while this job was queued behind another) —
    // re-checked fresh, immediately before any data is touched.
    const inspection = await this.broker.containerInspect();
    if (inspection.state.running) {
      throw new Error(
        'The managed container was started after this restore was queued. Stop it and start a new restore.',
      );
    }

    const destDir = join(this.backupDir, 'tmp', `restore-${id}`);
    try {
      ctx.log('info', 'Extracting archive...');
      await extractBackupArchiveForRestore(filePath, destDir);
      await restoreVolumesFromExtractedArchive(this.broker, destDir, ctx);
      return { backupId: id };
    } finally {
      await rm(destDir, { recursive: true, force: true });
    }
  }
}
