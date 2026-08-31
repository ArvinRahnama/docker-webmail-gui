/**
 * SQL access for the single-row `backup_schedule` table (migration 005).
 * Same shape discipline as the other repositories: one named method per
 * transition, no hand-written SQL elsewhere, booleans marshalled to/from
 * INTEGER 0/1 at this boundary so the rest of the app sees real `boolean`s.
 *
 * The row is created lazily on first read (`get()`), so callers never have to
 * seed it and a fresh database reports the "off" default without a bespoke
 * insert path.
 */
import type { Database } from '../../platform/db.js';
import type { BackupFrequency, BackupMode, BackupScheduleUpdate } from '@dwg/shared';

/** The persisted schedule as the server reasons about it — the derived view (`BackupSchedule`) is built from this by the service. */
export interface PersistedBackupSchedule {
  readonly frequency: BackupFrequency;
  readonly mode: BackupMode;
  readonly retentionKeep: number;
  readonly retentionMaxAgeDays: number | null;
  readonly uploadToRemote: boolean;
  /** ISO timestamp the policy last changed — the anchor for the next run after a policy change. */
  readonly updatedAt: string;
  /** ISO timestamp the scheduler last fired, or `null`. Once set it is the anchor instead of `updatedAt`. */
  readonly lastRunAt: string | null;
}

interface BackupScheduleRow {
  readonly frequency: string;
  readonly mode: string;
  readonly retention_keep: number;
  readonly retention_max_age_days: number | null;
  readonly upload_to_remote: number;
  readonly updated_at: string;
  readonly last_run_at: string | null;
}

function toPersisted(row: BackupScheduleRow): PersistedBackupSchedule {
  return {
    frequency: row.frequency as BackupFrequency,
    mode: row.mode as BackupMode,
    retentionKeep: row.retention_keep,
    retentionMaxAgeDays: row.retention_max_age_days,
    uploadToRemote: row.upload_to_remote !== 0,
    updatedAt: row.updated_at,
    lastRunAt: row.last_run_at,
  };
}

export class BackupScheduleRepository {
  constructor(private readonly db: Database) {}

  /** Reads the schedule, creating the default "off" row on first access. */
  get(): PersistedBackupSchedule {
    const existing = this.db.get<BackupScheduleRow>('SELECT * FROM backup_schedule WHERE id = 1');
    if (existing !== undefined) {
      return toPersisted(existing);
    }
    this.db.run(
      `INSERT INTO backup_schedule (id, frequency, mode, retention_keep, retention_max_age_days, upload_to_remote, updated_at, last_run_at)
       VALUES (1, 'off', 'warm', 3, NULL, 0, ?, NULL)`,
      [new Date().toISOString()],
    );
    return this.getOrThrow();
  }

  /**
   * Replaces the policy and resets the anchor: `updated_at` becomes now and
   * `last_run_at` is cleared, so the next run is exactly one interval from the
   * change (never immediate, never a catch-up burst from an old anchor).
   */
  updatePolicy(update: BackupScheduleUpdate): PersistedBackupSchedule {
    this.get(); // ensure the row exists
    this.db.run(
      `UPDATE backup_schedule
          SET frequency = ?, mode = ?, retention_keep = ?, retention_max_age_days = ?, upload_to_remote = ?, updated_at = ?, last_run_at = NULL
        WHERE id = 1`,
      [
        update.frequency,
        update.mode,
        update.retentionKeep,
        update.retentionMaxAgeDays,
        update.uploadToRemote ? 1 : 0,
        new Date().toISOString(),
      ],
    );
    return this.getOrThrow();
  }

  /** Records that the scheduler just fired, advancing the anchor to `at` so the next tick is not due. */
  markRan(at: string): PersistedBackupSchedule {
    this.get(); // ensure the row exists
    this.db.run('UPDATE backup_schedule SET last_run_at = ? WHERE id = 1', [at]);
    return this.getOrThrow();
  }

  private getOrThrow(): PersistedBackupSchedule {
    const row = this.db.get<BackupScheduleRow>('SELECT * FROM backup_schedule WHERE id = 1');
    if (row === undefined) {
      throw new Error(
        'BackupScheduleRepository: the singleton row is missing immediately after a write',
      );
    }
    return toPersisted(row);
  }
}
