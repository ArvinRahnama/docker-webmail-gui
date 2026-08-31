import { describe, expect, it, vi } from 'vitest';
import type { Job } from '@dwg/shared';
import { createDatabase } from '../../platform/db.js';
import { migrations, runMigrations } from '../../platform/migrations/index.js';
import { createLogger } from '../../platform/logger.js';
import { BackupScheduleRepository } from './backup-schedule.repository.js';
import { runScheduledBackupTickOnce } from './backup-scheduler.js';
import type { BackupsService } from './backups.service.js';

function fakeJob(id: string): Job {
  return {
    id,
    type: 'backup.create',
    status: 'queued',
    progress: 0,
    createdByAdminId: null,
    createdByLabel: 'Scheduled backup',
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    errorMessage: null,
    metadata: null,
  };
}

function setUp() {
  const db = createDatabase(':memory:');
  runMigrations(db, migrations);
  const scheduleRepository = new BackupScheduleRepository(db);
  const create = vi.fn((): Job => fakeJob('job_1'));
  const backupsService = { create } as unknown as BackupsService;
  const logger = createLogger({ level: 'silent' });
  return { db, scheduleRepository, backupsService, create, logger };
}

describe('runScheduledBackupTickOnce', () => {
  it('does nothing when the schedule is off', () => {
    const { db, scheduleRepository, backupsService, create, logger } = setUp();
    runScheduledBackupTickOnce({ db, scheduleRepository, backupsService, logger });
    expect(create).not.toHaveBeenCalled();
  });

  it('enqueues a backup when one is due, advances the anchor, and does not double-fire', () => {
    const { db, scheduleRepository, backupsService, create, logger } = setUp();
    scheduleRepository.get();
    db.run(
      `UPDATE backup_schedule SET frequency = 'daily', mode = 'warm', updated_at = ? WHERE id = 1`,
      [new Date('2020-01-01T00:00:00.000Z').toISOString()],
    );

    runScheduledBackupTickOnce({ db, scheduleRepository, backupsService, logger });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith('warm', { adminId: null, label: 'Scheduled backup' });

    // last_run_at advanced to ~now, so the next tick is not due.
    const after = scheduleRepository.get();
    expect(after.lastRunAt).not.toBeNull();

    runScheduledBackupTickOnce({ db, scheduleRepository, backupsService, logger });
    expect(create).toHaveBeenCalledTimes(1); // still one — no backlog

    // The scheduled backup is audited.
    const auditRows = db.all<{ action: string; actor_label: string }>(
      "SELECT action, actor_label FROM audit_log WHERE action = 'backup.create'",
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.actor_label).toBe('Scheduled backup');
  });

  it('uses the configured backup mode', () => {
    const { db, scheduleRepository, backupsService, create, logger } = setUp();
    scheduleRepository.get();
    db.run(
      `UPDATE backup_schedule SET frequency = 'weekly', mode = 'cold', updated_at = ? WHERE id = 1`,
      [new Date('2020-01-01T00:00:00.000Z').toISOString()],
    );
    runScheduledBackupTickOnce({ db, scheduleRepository, backupsService, logger });
    expect(create).toHaveBeenCalledWith('cold', { adminId: null, label: 'Scheduled backup' });
  });
});
