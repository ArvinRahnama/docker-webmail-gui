import { describe, expect, it } from 'vitest';
import { createDatabase } from '../../platform/db.js';
import { migrations, runMigrations } from '../../platform/migrations/index.js';
import { BackupScheduleRepository } from './backup-schedule.repository.js';
import {
  BackupScheduleService,
  computeNextRun,
  isBackupDue,
  nextRunAtOf,
} from './backup-schedule.service.js';

const ANCHOR = new Date('2026-08-01T12:00:00.000Z');

describe('computeNextRun', () => {
  it('returns null when off', () => {
    expect(computeNextRun('off', ANCHOR)).toBeNull();
  });

  it('advances by the fixed interval for day-based frequencies', () => {
    expect(computeNextRun('daily', ANCHOR)?.toISOString()).toBe('2026-08-02T12:00:00.000Z');
    expect(computeNextRun('every3days', ANCHOR)?.toISOString()).toBe('2026-08-04T12:00:00.000Z');
    expect(computeNextRun('weekly', ANCHOR)?.toISOString()).toBe('2026-08-08T12:00:00.000Z');
  });

  it('advances by one calendar month for monthly (not a fixed 30 days)', () => {
    expect(computeNextRun('monthly', ANCHOR)?.toISOString()).toBe('2026-09-01T12:00:00.000Z');
    // February handling: a Jan 31 anchor rolls forward past February's end.
    const jan31 = new Date('2026-01-31T00:00:00.000Z');
    // JS Date normalises Feb 31 -> Mar 3; the point is it is a calendar step,
    // not +30 days, and it is deterministic.
    expect(computeNextRun('monthly', jan31)?.toISOString()).toBe('2026-03-03T00:00:00.000Z');
  });
});

function setUp() {
  const db = createDatabase(':memory:');
  runMigrations(db, migrations);
  const repository = new BackupScheduleRepository(db);
  const service = new BackupScheduleService(repository);
  return { db, repository, service };
}

describe('BackupScheduleService', () => {
  it('defaults to off, disabled, with no next run', () => {
    const { service } = setUp();
    const schedule = service.get();
    expect(schedule).toMatchObject({ frequency: 'off', enabled: false, nextRunAt: null });
  });

  it('after enabling, next run is one interval from the policy change (not immediate)', () => {
    const { service } = setUp();
    const before = Date.now();
    const updated = service.update({
      frequency: 'daily',
      mode: 'warm',
      retentionKeep: 7,
      retentionMaxAgeDays: null,
      uploadToRemote: true,
    });
    expect(updated.enabled).toBe(true);
    expect(updated.nextRunAt).not.toBeNull();
    const next = new Date(updated.nextRunAt!).getTime();
    // ~24h out from "now", never in the past (so no surprise immediate run).
    expect(next).toBeGreaterThan(before + 23 * 60 * 60 * 1000);
  });

  it('isBackupDue is true once the anchor + interval has passed', () => {
    const { db, repository } = setUp();
    repository.get(); // ensure the row exists
    db.run(`UPDATE backup_schedule SET frequency = 'daily', updated_at = ? WHERE id = 1`, [
      new Date('2020-01-01T00:00:00.000Z').toISOString(),
    ]);
    const persisted = repository.get();
    expect(isBackupDue(persisted, new Date())).toBe(true);
    // And a fresh (just-set) daily schedule is not yet due.
    const fresh = repository.updatePolicy({
      frequency: 'daily',
      mode: 'warm',
      retentionKeep: 7,
      retentionMaxAgeDays: null,
      uploadToRemote: true,
    });
    expect(isBackupDue(fresh, new Date())).toBe(false);
    expect(nextRunAtOf(fresh)).not.toBeNull();
  });
});
