/**
 * The uploader/retention orchestration — the layer that turns a local backup
 * archive into a verified remote copy and enforces the storage policy. It sits
 * above `BackupsRepository` (the 006 upload-state machine) and a
 * {@link BackupDestination}, and below the routes/scheduler that trigger it.
 *
 * The two invariants this file exists to hold (docs/AGENT_BRIEF, the highest-
 * risk part of the feature — a bug here loses real mail backups):
 *
 *  1. **Delete-local only after the remote copy is checksum-verified.** A
 *     backup's local archive is reclaimed exclusively in `reclaimLocalStaging`,
 *     which acts only on rows in state `uploaded` — and the *only* thing that
 *     sets `uploaded` is `uploadOne`, after `verifyRemoteCopy` downloads the
 *     object back and runs the exact same `verifyBackupArchive` local restore
 *     uses. No other path deletes a local archive.
 *
 *  2. **Prune the remote only after the replacement is verified.** Retention
 *     runs after uploads, and a failed/unverified upload leaves nothing on the
 *     remote (its object is deleted on failure). So everything `dest.list()`
 *     returns is a verified copy, and pruning the older ones past the keep
 *     window can never remove the last good copy — `selectBackupsForDeletion`
 *     additionally never selects the single newest.
 *
 * Uploads/downloads run in the server tier over HTTP; no broker op, no Docker
 * socket, no client-supplied path or URL. Failures are recorded as safe,
 * non-secret summaries — the destination never puts a signed URL or credential
 * in an error message.
 */
import { mkdir, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { recordAuditEvent, type AuditAction, type AuditResult } from '../../platform/audit.js';
import type { Database } from '../../platform/db.js';
import { AppError, generateId } from '../../platform/errors.js';
import { verifyBackupArchive } from './backup-archive.js';
import { selectBackupsForDeletion, type RetentionPolicy } from './backup-retention.js';
import type { BackupsRepository } from './backups.repository.js';
import { backupIdFromKey, type BackupDestination } from './destinations/destination.js';

/** Actor recorded for uploads/prunes the system triggers itself (scheduler, reconnect sweep) rather than an admin clicking a button. */
export interface UploadActor {
  readonly adminId: string | null;
  readonly label: string;
}
export const SYSTEM_UPLOAD_ACTOR: UploadActor = { adminId: null, label: 'Automatic upload' };

export type UploadOutcome =
  | { readonly status: 'uploaded' }
  | { readonly status: 'skipped'; readonly reason: 'no-destination' | 'not-local' }
  | { readonly status: 'failed'; readonly error: string };

export interface ReconcileSummary {
  readonly skipped: boolean;
  readonly uploaded: number;
  readonly failed: number;
  readonly pruned: number;
  readonly reclaimed: number;
}

export interface BackupUploaderDeps {
  readonly db: Database;
  readonly backupsRepository: BackupsRepository;
  /** The currently-configured destination, or `null` when none is configured. Re-read each call so a mid-session config change is picked up. */
  readonly destinationProvider: () => BackupDestination | null;
  /** The remote retention policy (all numbers user-configurable in Settings). */
  readonly retentionPolicy: () => RetentionPolicy;
  /** Where to stage temporary download-verify scratch files. */
  readonly backupDir: string;
  readonly logger: Logger;
  readonly now?: () => Date;
}

export class BackupUploader {
  private readonly nowFn: () => Date;

  constructor(private readonly deps: BackupUploaderDeps) {
    this.nowFn = deps.now ?? ((): Date => new Date());
  }

  /**
   * Uploads one backup and, if it lands verified, applies remote retention and
   * reclaims local staging. Backs the "Upload to remote" / "Retry upload"
   * actions. Never throws for a remote failure — it records the `failed` state
   * and returns the outcome, so the local archive is kept for a later retry.
   */
  async uploadBackup(
    backupId: string,
    actor: UploadActor = SYSTEM_UPLOAD_ACTOR,
  ): Promise<UploadOutcome> {
    const outcome = await this.uploadOne(backupId, actor);
    if (outcome.status === 'uploaded') {
      const destination = this.deps.destinationProvider();
      if (destination !== null) {
        await this.applyRemoteRetention(destination, actor);
        await this.reclaimLocalStaging();
      }
    }
    return outcome;
  }

  /**
   * Reconcile-on-(re)connection: upload every local backup not yet on the
   * remote (oldest first), then apply remote retention and reclaim local
   * staging. Also the after-create hook and the periodic sweep. A no-op when
   * no destination is configured.
   *
   * Multiple-pending edge case (several local backups accumulated while the
   * remote was unreachable): all are uploaded and verified, then retention
   * prunes the remote back to the newest `keep`. Correctness over bandwidth —
   * an out-of-window backup may briefly round-trip before being pruned, rather
   * than being dropped locally unsent; nothing is ever deleted anywhere until a
   * verified newer copy exists.
   */
  async reconcile(actor: UploadActor = SYSTEM_UPLOAD_ACTOR): Promise<ReconcileSummary> {
    const destination = this.deps.destinationProvider();
    if (destination === null) {
      return { skipped: true, uploaded: 0, failed: 0, pruned: 0, reclaimed: 0 };
    }

    // Best-effort: clear any multipart parts a previous crash orphaned before starting new work.
    await destination.cleanupInterruptedUploads().catch(() => undefined);

    let uploaded = 0;
    let failed = 0;
    for (const row of this.deps.backupsRepository.listUploadCandidates()) {
      const outcome = await this.uploadOne(row.id, actor);
      if (outcome.status === 'uploaded') uploaded += 1;
      else if (outcome.status === 'failed') failed += 1;
    }

    const pruned = await this.applyRemoteRetention(destination, actor);
    const reclaimed = await this.reclaimLocalStaging();
    return { skipped: false, uploaded, failed, pruned, reclaimed };
  }

  // -------------------------------------------------------------------------

  /** Uploads one backup and verifies the remote copy. Sets `uploaded` on success or `failed` on any error, never throwing for a remote failure. Does NOT prune or reclaim — callers compose that. */
  private async uploadOne(backupId: string, actor: UploadActor): Promise<UploadOutcome> {
    const destination = this.deps.destinationProvider();
    if (destination === null) return { status: 'skipped', reason: 'no-destination' };

    const row = this.deps.backupsRepository.getRowById(backupId);
    if (row === null) throw new AppError('NOT_FOUND', `No backup with id ${backupId}.`);
    if (row.local_present === 0) return { status: 'skipped', reason: 'not-local' };

    const manifest = this.deps.backupsRepository.getManifestById(backupId);
    if (manifest === null) throw new AppError('NOT_FOUND', `No backup with id ${backupId}.`);

    const key = destination.keyForBackup(backupId);
    this.deps.backupsRepository.markUploading(backupId);

    try {
      await destination.upload({ key, filePath: row.file_path, sizeBytes: row.size_bytes });
      await this.verifyRemoteCopy(destination, key, manifest);
      this.deps.backupsRepository.markUploaded(backupId, {
        destination: destination.describe,
        remoteKey: key,
        uploadedAt: this.nowFn().toISOString(),
      });
      this.audit(actor, 'backup.upload', backupId, 'success', { destination: destination.type });
      this.deps.logger.info(
        { backupId, destination: destination.describe },
        'Backup uploaded and verified on the remote',
      );
      return { status: 'uploaded' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Upload failed.';
      // A failed or unverified upload must leave nothing on the remote that
      // could later masquerade as a good backup.
      await destination.delete(key).catch(() => undefined);
      this.deps.backupsRepository.markUploadFailed(backupId, message);
      this.audit(actor, 'backup.upload', backupId, 'failure', { destination: destination.type });
      this.deps.logger.warn({ backupId }, 'Backup upload failed; local copy kept for retry');
      return { status: 'failed', error: message };
    }
  }

  /** Downloads the just-uploaded object back and runs the same checksum verification local restore uses. Throws if it does not verify. */
  private async verifyRemoteCopy(
    destination: BackupDestination,
    key: string,
    manifest: Parameters<typeof verifyBackupArchive>[1],
  ): Promise<void> {
    const tmpDir = join(this.deps.backupDir, 'tmp');
    await mkdir(tmpDir, { recursive: true });
    const tmpPath = join(tmpDir, `${generateId('vfy')}.tar`);
    try {
      await destination.download(key, tmpPath);
      const result = await verifyBackupArchive(tmpPath, manifest);
      if (!result.ok) {
        throw new AppError(
          'UPSTREAM_UNAVAILABLE',
          `The uploaded copy failed verification on the remote: ${result.reason ?? 'unknown reason'}`,
        );
      }
    } finally {
      await rm(tmpPath, { force: true });
    }
  }

  /**
   * Prunes the remote back to the retention policy, then reconciles the DB for
   * each pruned object. Safe by construction: everything on the remote is a
   * verified copy (see the module header), and `selectBackupsForDeletion` never
   * selects the single newest. Returns the number pruned.
   */
  private async applyRemoteRetention(
    destination: BackupDestination,
    actor: UploadActor,
  ): Promise<number> {
    const remote = await destination.list();
    const toDelete = selectBackupsForDeletion(
      remote.map((backup) => ({ id: backup.key, createdAt: backup.lastModified })),
      this.deps.retentionPolicy(),
      this.nowFn(),
    );

    let pruned = 0;
    for (const key of toDelete) {
      await destination.delete(key);
      pruned += 1;

      // Reconcile the DB: the object is gone from the remote now.
      const row = this.deps.backupsRepository.getRowByRemoteKey(key);
      if (row !== null) {
        if (row.local_present !== 0) {
          // Still on the VPS — it becomes a local-only backup again.
          this.deps.backupsRepository.clearUpload(row.id);
        } else {
          // Gone from both remote and VPS (it was past the keep window) — drop the row.
          this.deps.backupsRepository.delete(row.id);
        }
      }
      this.audit(actor, 'backup.remote_prune', backupIdFromKey(key) ?? key, 'success', {
        destination: destination.type,
      });
    }
    return pruned;
  }

  /**
   * Deletes the local archive of every backup whose remote copy is verified
   * (state `uploaded`) — the VPS is a staging area, never permanent storage
   * for an uploaded backup. This is the ONLY place a local archive is reclaimed
   * for the remote-storage policy. Returns the number reclaimed.
   */
  private async reclaimLocalStaging(): Promise<number> {
    let reclaimed = 0;
    for (const row of this.deps.backupsRepository.listUploaded()) {
      if (row.local_present === 0) continue; // already reclaimed
      await unlink(row.file_path).catch(() => undefined);
      this.deps.backupsRepository.markLocalReclaimed(row.id);
      reclaimed += 1;
    }
    return reclaimed;
  }

  private audit(
    actor: UploadActor,
    action: AuditAction,
    backupId: string,
    result: AuditResult,
    details: Record<string, string>,
  ): void {
    recordAuditEvent(this.deps.db, {
      actor: { adminId: actor.adminId, label: actor.label },
      action,
      target: { type: 'backup', id: backupId },
      result,
      ip: null,
      userAgent: null,
      details,
    });
  }
}
