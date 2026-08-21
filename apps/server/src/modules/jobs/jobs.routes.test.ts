import { describe, expect, it } from 'vitest';
import { createDatabase } from '../../platform/db.js';
import { migrations, runMigrations } from '../../platform/migrations/index.js';
import { JobsRepository } from '../../platform/jobs/jobs.repository.js';
import { JobRunner } from '../../platform/jobs/job-runner.js';
import { authedInject, loginAs, setUpJobsApp, testLogger } from './jobs-test-harness.js';

describe('/api/v1/jobs', () => {
  it('requires authentication', async () => {
    const { app } = await setUpJobsApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/jobs' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('lists jobs most-recent-first', async () => {
    const db = createDatabase(':memory:');
    runMigrations(db, migrations);
    const repository = new JobsRepository(db);
    const runner = new JobRunner(repository, testLogger());
    const { app } = await setUpJobsApp({ jobRunner: runner }, db);
    const auth = await loginAs(app);

    runner.enqueue({
      type: 'backup.create',
      createdByAdminId: null,
      createdByLabel: 'a@example.com',
      metadata: { mode: 'warm' },
      execute: async () => ({ backupId: 'bkp_1' }),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const response = await authedInject(app, auth, { method: 'GET', url: '/api/v1/jobs' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { jobs: { type: string; status: string }[] };
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0]?.type).toBe('backup.create');
    expect(body.jobs[0]?.status).toBe('succeeded');
    await app.close();
  });

  it('returns 404 for an unknown job id', async () => {
    const { app } = await setUpJobsApp();
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/jobs/job_does_not_exist',
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('returns job detail with logs', async () => {
    const db = createDatabase(':memory:');
    runMigrations(db, migrations);
    const repository = new JobsRepository(db);
    const runner = new JobRunner(repository, testLogger());
    const { app } = await setUpJobsApp({ jobRunner: runner }, db);
    const auth = await loginAs(app);

    const job = runner.enqueue({
      type: 'backup.verify',
      createdByAdminId: null,
      createdByLabel: 'a@example.com',
      metadata: null,
      execute: async (ctx) => {
        ctx.log('info', 'checking checksums');
        return null;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: `/api/v1/jobs/${job.id}`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { job: { status: string }; logs: { message: string }[] };
    expect(body.job.status).toBe('succeeded');
    expect(body.logs.map((l) => l.message)).toContain('checking checksums');
    await app.close();
  });

  it('cancels a queued job and audits it', async () => {
    const db = createDatabase(':memory:');
    runMigrations(db, migrations);
    const repository = new JobsRepository(db);
    const runner = new JobRunner(repository, testLogger());
    const { app } = await setUpJobsApp({ jobRunner: runner }, db);
    const auth = await loginAs(app);

    let blockerResolve: (() => void) | undefined;
    const blocker = new Promise<void>((resolve) => {
      blockerResolve = resolve;
    });
    runner.enqueue({
      type: 'backup.create',
      createdByAdminId: null,
      createdByLabel: 'a@example.com',
      metadata: null,
      execute: async () => {
        await blocker;
        return null;
      },
    });
    const queued = runner.enqueue({
      type: 'backup.verify',
      createdByAdminId: null,
      createdByLabel: 'a@example.com',
      metadata: null,
      execute: async () => null,
    });

    const response = await authedInject(app, auth, {
      method: 'POST',
      url: `/api/v1/jobs/${queued.id}/cancel`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { job: { status: string } };
    expect(body.job.status).toBe('cancelled');

    const rows = db.all<{ action: string }>(
      "SELECT action FROM audit_log WHERE action = 'job.cancel'",
    );
    expect(rows).toHaveLength(1);

    blockerResolve?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await app.close();
  });

  it('refuses to cancel an already-running job with CONFLICT', async () => {
    const db = createDatabase(':memory:');
    runMigrations(db, migrations);
    const repository = new JobsRepository(db);
    const runner = new JobRunner(repository, testLogger());
    const { app } = await setUpJobsApp({ jobRunner: runner }, db);
    const auth = await loginAs(app);

    let blockerResolve: (() => void) | undefined;
    const blocker = new Promise<void>((resolve) => {
      blockerResolve = resolve;
    });
    const running = runner.enqueue({
      type: 'backup.create',
      createdByAdminId: null,
      createdByLabel: 'a@example.com',
      metadata: null,
      execute: async () => {
        await blocker;
        return null;
      },
    });

    const response = await authedInject(app, auth, {
      method: 'POST',
      url: `/api/v1/jobs/${running.id}/cancel`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CONFLICT');

    blockerResolve?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await app.close();
  });
});
