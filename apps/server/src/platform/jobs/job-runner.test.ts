import { describe, expect, it } from 'vitest';
import type { JobStreamEvent, JsonValue } from '@dwg/shared';
import { createDatabase } from '../db.js';
import { migrations, runMigrations } from '../migrations/index.js';
import { createLogger } from '../logger.js';
import { JobsRepository } from './jobs.repository.js';
import { JobNotCancellableError, JobRunner } from './job-runner.js';

function setUp() {
  const db = createDatabase(':memory:');
  runMigrations(db, migrations);
  const repository = new JobsRepository(db);
  const logger = createLogger({ level: 'silent' });
  const runner = new JobRunner(repository, logger);
  return { db, repository, runner };
}

/** A promise plus its own resolve/reject, so a test can control exactly when an `execute` closure finishes. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('JobRunner', () => {
  it('runs jobs strictly one at a time: a second enqueued job never starts before the first finishes', async () => {
    const { runner, repository } = setUp();
    const first = deferred<JsonValue>();
    const events: string[] = [];

    const job1 = runner.enqueue({
      type: 'backup.create',
      createdByAdminId: null,
      createdByLabel: 'admin@example.com',
      metadata: null,
      execute: async () => {
        events.push('job1-start');
        const result = await first.promise;
        events.push('job1-end');
        return result;
      },
    });

    const job2 = runner.enqueue({
      type: 'backup.verify',
      createdByAdminId: null,
      createdByLabel: 'admin@example.com',
      metadata: null,
      execute: async () => {
        events.push('job2-start');
        return null;
      },
    });

    // job1 is running, job2 is still queued behind it — asserted before
    // job1 is ever allowed to finish, so this is a real ordering check,
    // not just a final-state coincidence.
    expect(runner.currentJobId).toBe(job1.id);
    expect(runner.queueLength).toBe(1);
    expect(events).toEqual(['job1-start']);

    first.resolve(null);
    // Let both the job1 microtask chain and the pump()-triggered job2 settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toEqual(['job1-start', 'job1-end', 'job2-start']);
    expect(runner.currentJobId).toBeNull();

    const finished1 = repository.getById(job1.id);
    const finished2 = repository.getById(job2.id);
    expect(finished1?.status).toBe('succeeded');
    expect(finished2?.status).toBe('succeeded');
  });

  it('marks a job failed (with the thrown message) rather than leaving it running forever', async () => {
    const { runner, repository } = setUp();
    const job = runner.enqueue({
      type: 'backup.create',
      createdByAdminId: null,
      createdByLabel: 'admin@example.com',
      metadata: null,
      execute: async () => {
        throw new Error('archive-get failed: broker unreachable');
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const finished = repository.getById(job.id);
    expect(finished?.status).toBe('failed');
    expect(finished?.errorMessage).toBe('archive-get failed: broker unreachable');
  });

  it('reports progress and log lines through subscribe(), in order', async () => {
    const { runner } = setUp();
    const events: JobStreamEvent[] = [];

    // `await Promise.resolve()` before the first `log()` call is
    // deliberate: it yields once, so `enqueue()` returns to this test
    // (and `subscribe()` runs) *before* the job body publishes anything —
    // exactly the ordering a real handler doing actual I/O would have,
    // unlike a fully synchronous closure whose events would otherwise all
    // fire before any subscriber could attach.
    const job = runner.enqueue({
      type: 'backup.create',
      createdByAdminId: null,
      createdByLabel: 'admin@example.com',
      metadata: null,
      execute: async (ctx) => {
        await Promise.resolve();
        ctx.log('info', 'starting');
        ctx.setProgress(50);
        ctx.log('info', 'halfway');
        return { backupId: 'bkp_1' };
      },
    });

    const unsubscribe = runner.subscribe(job.id, (event) => events.push(event));
    await new Promise((resolve) => setTimeout(resolve, 0));
    unsubscribe();

    const kinds = events.map((event) => event.kind);
    expect(kinds).toContain('log');
    expect(kinds).toContain('snapshot');

    const logEvents = events.filter((event) => event.kind === 'log');
    expect(logEvents.map((event) => event.entry.message)).toEqual(['starting', 'halfway']);

    const lastSnapshot = [...events].reverse().find((event) => event.kind === 'snapshot');
    expect(lastSnapshot?.kind).toBe('snapshot');
    if (lastSnapshot?.kind === 'snapshot') {
      expect(lastSnapshot.job.status).toBe('succeeded');
      expect(lastSnapshot.job.metadata).toEqual({ backupId: 'bkp_1' });
    }
  });

  it('cancels a queued job before it ever executes', async () => {
    const { runner } = setUp();
    const executed: string[] = [];

    // Occupy the runner with a job that never resolves on its own, so the
    // second job stays queued long enough to cancel.
    const blocker = deferred<JsonValue>();
    runner.enqueue({
      type: 'backup.create',
      createdByAdminId: null,
      createdByLabel: 'admin@example.com',
      metadata: null,
      execute: () => blocker.promise,
    });

    const queued = runner.enqueue({
      type: 'backup.verify',
      createdByAdminId: null,
      createdByLabel: 'admin@example.com',
      metadata: null,
      execute: async () => {
        executed.push('should-not-run');
        return null;
      },
    });

    const cancelled = runner.cancel(queued.id);
    expect(cancelled.status).toBe('cancelled');
    expect(runner.queueLength).toBe(0);

    blocker.resolve(null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(executed).toEqual([]);
  });

  it('refuses to cancel a job that is already running', async () => {
    const { runner } = setUp();
    const blocker = deferred<JsonValue>();
    const job = runner.enqueue({
      type: 'backup.restore',
      createdByAdminId: null,
      createdByLabel: 'admin@example.com',
      metadata: null,
      execute: () => blocker.promise,
    });

    expect(() => runner.cancel(job.id)).toThrow(JobNotCancellableError);
    blocker.resolve(null);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('refuses to cancel an unknown job id', () => {
    const { runner } = setUp();
    expect(() => runner.cancel('job_does_not_exist')).toThrow(JobNotCancellableError);
  });
});
