/**
 * The server-side timer that turns a persisted schedule into enqueued
 * backups. Copies `rspamd-sampler.ts`'s shape exactly: a single pure
 * `...TickOnce` function (unit-tested without waiting on a real interval) and
 * a thin `start...` that arms an `.unref()`d `setInterval` over it.
 *
 * **Re-armed from the database on every startup.** The schedule lives in
 * `backup_schedule`, not in the timer; the timer only asks "is a backup due
 * right now?" each tick. So a redeploy or crash restart resumes the schedule
 * automatically — nothing is lost the way an in-memory-only next-run would be.
 *
 * Each firing is audited here (not by `BackupsService.create`, which audits
 * only when a route calls it with an admin actor): the scheduler is the actor,
 * with the fixed label `Scheduled backup` and no admin id.
 */
import type { Logger } from 'pino';
import { recordAuditEvent } from '../../platform/audit.js';
import type { Database } from '../../platform/db.js';
import type { BackupScheduleRepository } from './backup-schedule.repository.js';
import { isBackupDue } from './backup-schedule.service.js';
import type { BackupsService } from './backups.service.js';

/** Fixed actor label for every scheduled (non-admin) backup — matches the audit trail and the job's `createdByLabel`. */
export const SCHEDULED_BACKUP_LABEL = 'Scheduled backup';

/** How often the timer checks whether a backup is due. Well below the shortest schedule interval (a day), so a due backup fires promptly. */
const DEFAULT_TICK_INTERVAL_MS = 60 * 1000;

export interface ScheduledBackupTickDeps {
  readonly db: Database;
  readonly scheduleRepository: BackupScheduleRepository;
  readonly backupsService: BackupsService;
  readonly logger: Logger;
}

/**
 * One scheduler tick. Enqueues at most one backup — if a run is due, it fires
 * exactly one and advances the anchor so the next tick is not due (no backlog
 * catch-up for missed intervals while the server was down). A no-op when the
 * schedule is off or not yet due.
 */
export function runScheduledBackupTickOnce(deps: ScheduledBackupTickDeps): void {
  const schedule = deps.scheduleRepository.get();
  if (schedule.frequency === 'off') return;
  if (!isBackupDue(schedule, new Date())) return;

  const job = deps.backupsService.create(schedule.mode, {
    adminId: null,
    label: SCHEDULED_BACKUP_LABEL,
  });

  // Advance the anchor before returning, so a second tick in the same minute
  // (or an overlapping timer) cannot double-fire.
  deps.scheduleRepository.markRan(new Date().toISOString());

  recordAuditEvent(deps.db, {
    actor: { adminId: null, label: SCHEDULED_BACKUP_LABEL },
    action: 'backup.create',
    target: { type: 'backup', id: job.id },
    result: 'success',
    ip: null,
    userAgent: null,
    details: { mode: schedule.mode, trigger: 'schedule' },
  });

  deps.logger.info(
    { jobId: job.id, mode: schedule.mode },
    'Scheduled backup enqueued from persisted schedule',
  );
}

export interface BackupSchedulerHandle {
  stop(): void;
}

/**
 * Arms the periodic scheduler. The timer is `.unref()`d so it never keeps the
 * process (or a test harness) alive on its own; `stop()` clears it for
 * deterministic shutdown (`app.ts`'s `onClose` hook).
 */
export function startBackupScheduler(
  deps: ScheduledBackupTickDeps,
  intervalMs: number = DEFAULT_TICK_INTERVAL_MS,
): BackupSchedulerHandle {
  const timer = setInterval(() => {
    try {
      runScheduledBackupTickOnce(deps);
    } catch (err: unknown) {
      deps.logger.warn({ err }, 'Scheduled backup tick failed');
    }
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
