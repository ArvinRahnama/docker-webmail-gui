/**
 * The scheduling policy layer over `BackupScheduleRepository`. Holds the pure
 * next-run maths (`computeNextRun`/`isBackupDue`/`nextRunAtOf`, exported so
 * the scheduler and the tests can use them without the service instance) and
 * the read/update surface the routes expose.
 *
 * The anchor a run is measured from is `lastRunAt ?? updatedAt`: before the
 * schedule has ever fired, the next run is one interval from the last policy
 * change; after it fires, one interval from that firing — which is what keeps
 * a due backup from replaying a backlog.
 */
import type { BackupFrequency, BackupSchedule, BackupScheduleUpdate } from '@dwg/shared';
import type {
  BackupScheduleRepository,
  PersistedBackupSchedule,
} from './backup-schedule.repository.js';

/** The Date a schedule's next run is measured from: its last firing if any, else its last policy change. */
function anchorOf(schedule: PersistedBackupSchedule): Date {
  return new Date(schedule.lastRunAt ?? schedule.updatedAt);
}

/**
 * The next run after `anchor` for a frequency, or `null` when off. Day-based
 * frequencies advance by a fixed number of days; `monthly` advances by one
 * *calendar* month (via `setUTCMonth`), so a Jan-31 anchor rolls forward
 * deterministically past February's end rather than by a fixed 30 days.
 */
export function computeNextRun(frequency: BackupFrequency, anchor: Date): Date | null {
  const next = new Date(anchor.getTime());
  switch (frequency) {
    case 'off':
      return null;
    case 'daily':
      next.setUTCDate(next.getUTCDate() + 1);
      return next;
    case 'every3days':
      next.setUTCDate(next.getUTCDate() + 3);
      return next;
    case 'weekly':
      next.setUTCDate(next.getUTCDate() + 7);
      return next;
    case 'monthly':
      next.setUTCMonth(next.getUTCMonth() + 1);
      return next;
  }
}

/** ISO next-run timestamp for a persisted schedule, or `null` when off. */
export function nextRunAtOf(schedule: PersistedBackupSchedule): string | null {
  return computeNextRun(schedule.frequency, anchorOf(schedule))?.toISOString() ?? null;
}

/** Whether `now` has reached the schedule's next run — false when off. */
export function isBackupDue(schedule: PersistedBackupSchedule, now: Date): boolean {
  const next = computeNextRun(schedule.frequency, anchorOf(schedule));
  return next !== null && now.getTime() >= next.getTime();
}

function toView(schedule: PersistedBackupSchedule): BackupSchedule {
  return {
    frequency: schedule.frequency,
    enabled: schedule.frequency !== 'off',
    mode: schedule.mode,
    retentionKeep: schedule.retentionKeep,
    retentionMaxAgeDays: schedule.retentionMaxAgeDays,
    uploadToRemote: schedule.uploadToRemote,
    lastRunAt: schedule.lastRunAt,
    nextRunAt: nextRunAtOf(schedule),
    updatedAt: schedule.updatedAt,
  };
}

export class BackupScheduleService {
  constructor(private readonly repository: BackupScheduleRepository) {}

  get(): BackupSchedule {
    return toView(this.repository.get());
  }

  update(update: BackupScheduleUpdate): BackupSchedule {
    return toView(this.repository.updatePolicy(update));
  }
}
