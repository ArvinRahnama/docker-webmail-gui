import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PanelSelfUpdateCheckResponse } from '@dwg/shared';
import { FakeBrokerClient } from '../../drivers/broker/fake-broker-client.js';
import type { BrokerClient } from '../../drivers/broker/types.js';
import {
  FakeSelfUpdateReleaseSource,
  FIXTURE_LATEST_VERSION,
  type SelfUpdateReleaseSourcePort,
} from '../../drivers/self-update/index.js';
import { createDatabase } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import { migrations, runMigrations } from '../../platform/migrations/index.js';
import { createLogger } from '../../platform/logger.js';
import { JobRunner } from '../../platform/jobs/job-runner.js';
import { JobsRepository } from '../../platform/jobs/jobs.repository.js';
import { PanelSelfUpdateService } from './panel-self-update.service.js';

const CURRENT_VERSION = '0.2.0'; // matches FakeBrokerClient's own fixture-derived panelSelfUpdateCheck

function tmpDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'dwg-panel-self-update-service-test-'));
}

/** A promise plus its own resolve/reject, so a test can control exactly when an `execute` closure finishes — mirrors `job-runner.test.ts`'s own `deferred` helper. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function setUp(
  overrides: {
    broker?: BrokerClient;
    releaseSource?: SelfUpdateReleaseSourcePort;
  } = {},
) {
  const db = createDatabase(':memory:');
  runMigrations(db, migrations);
  const jobsRepository = new JobsRepository(db);
  const jobRunner = new JobRunner(jobsRepository, createLogger({ level: 'silent' }));
  const broker = overrides.broker ?? new FakeBrokerClient();
  const releaseSource = overrides.releaseSource ?? new FakeSelfUpdateReleaseSource();
  const dataDir = tmpDataDir();
  const service = new PanelSelfUpdateService(
    broker,
    releaseSource,
    jobRunner,
    jobsRepository,
    dataDir,
  );
  return { db, jobsRepository, jobRunner, broker, releaseSource, dataDir, service };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('PanelSelfUpdateService.getStatus', () => {
  it('reports updateAvailable: true when the resolved latest release differs from the running version', async () => {
    const { service } = setUp();
    const status = await service.getStatus();
    expect(status).toEqual({
      currentVersion: CURRENT_VERSION,
      latestVersion: FIXTURE_LATEST_VERSION,
      updateAvailable: true,
      updatePossible: true,
      reason: null,
    });
  });

  it('reports updateAvailable: false when the running version already matches the latest release', async () => {
    const releaseSource: SelfUpdateReleaseSourcePort = {
      resolveLatestRelease: async () => ({
        version: CURRENT_VERSION,
        publishedAt: '2026-01-01T00:00:00.000Z',
      }),
    };
    const { service } = setUp({ releaseSource });
    const status = await service.getStatus();
    expect(status.updateAvailable).toBe(false);
    expect(status.updatePossible).toBe(true);
  });

  it("reports updatePossible: false with the broker's own reason for a build-mode install, even though a newer release exists", async () => {
    const refusal: PanelSelfUpdateCheckResponse = {
      serverVersion: null,
      brokerVersion: null,
      updatePossible: false,
      reason: 'Could not determine the currently running version from local image tags.',
    };
    const broker = Object.assign(new FakeBrokerClient(), {
      panelSelfUpdateCheck: async () => refusal,
    });
    const { service } = setUp({ broker });
    const status = await service.getStatus();
    expect(status).toEqual({
      currentVersion: null,
      latestVersion: FIXTURE_LATEST_VERSION,
      updateAvailable: false,
      updatePossible: false,
      reason: refusal.reason,
    });
  });

  it('reports updatePossible: false (Unknown, not a crash) when the release source cannot be reached', async () => {
    const releaseSource: SelfUpdateReleaseSourcePort = {
      resolveLatestRelease: async () => null,
    };
    const { service } = setUp({ releaseSource });
    const status = await service.getStatus();
    expect(status.currentVersion).toBe(CURRENT_VERSION);
    expect(status.latestVersion).toBeNull();
    expect(status.updateAvailable).toBe(false);
    expect(status.updatePossible).toBe(false);
    expect(status.reason).toBeTruthy();
  });
});

describe('PanelSelfUpdateService.apply — concurrency guard (§9.5)', () => {
  it('refuses with CONFLICT while a backup/restore job is in flight, and enqueues nothing', async () => {
    const { service, jobRunner, jobsRepository } = setUp();
    const hold = deferred<null>();
    jobRunner.enqueue({
      type: 'backup.create',
      createdByAdminId: null,
      createdByLabel: 'someone@example.com',
      metadata: null,
      execute: async () => hold.promise,
    });

    const before = jobsRepository.list().length;
    await expect(
      service.apply({ adminId: null, label: 'admin@example.com' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' } satisfies Partial<AppError>);
    expect(jobsRepository.list().length).toBe(before); // nothing new was enqueued

    hold.resolve(null);
    await settle();
  });

  it('proceeds once the conflicting backup job has finished', async () => {
    const { service, jobRunner } = setUp();
    const hold = deferred<null>();
    jobRunner.enqueue({
      type: 'backup.verify',
      createdByAdminId: null,
      createdByLabel: 'someone@example.com',
      metadata: null,
      execute: async () => hold.promise,
    });

    await expect(
      service.apply({ adminId: null, label: 'admin@example.com' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    hold.resolve(null);
    await settle();

    await expect(
      service.apply({ adminId: null, label: 'admin@example.com' }),
    ).resolves.toMatchObject({ targetVersion: FIXTURE_LATEST_VERSION });
  });
});

describe('PanelSelfUpdateService.apply — job phase A', () => {
  it('enqueues a panel.selfUpdate job auto-targeting the resolved latest release, which calls panelSelfUpdateApply and succeeds', async () => {
    const applyCalls: string[] = [];
    const broker = Object.assign(new FakeBrokerClient(), {
      panelSelfUpdateApply: async (targetVersion: string) => {
        applyCalls.push(targetVersion);
      },
    });
    const { service, jobsRepository } = setUp({ broker });

    const { job, targetVersion } = await service.apply({
      adminId: null,
      label: 'admin@example.com',
    });
    expect(targetVersion).toBe(FIXTURE_LATEST_VERSION);
    expect(job.type).toBe('panel.selfUpdate');
    expect(job.metadata).toEqual({ targetVersion: FIXTURE_LATEST_VERSION });

    await settle();

    const finished = jobsRepository.getById(job.id);
    expect(finished?.status).toBe('succeeded');
    expect(finished?.metadata).toEqual({
      targetVersion: FIXTURE_LATEST_VERSION,
      fromVersion: CURRENT_VERSION,
    });
    expect(applyCalls).toEqual([FIXTURE_LATEST_VERSION]);
  });

  it('logs the pre-flight check and both pull announcements before the point of no return', async () => {
    const { service, jobsRepository } = setUp();
    const { job } = await service.apply({ adminId: null, label: 'admin@example.com' });
    await settle();

    const logs = jobsRepository.listLogs(job.id).map((entry) => entry.message);
    expect(logs.some((message) => message.includes('Checking'))).toBe(true);
    expect(
      logs.some(
        (message) => message.toLowerCase().includes('pulling') && message.includes('server'),
      ),
    ).toBe(true);
    expect(
      logs.some(
        (message) => message.toLowerCase().includes('pulling') && message.includes('broker'),
      ),
    ).toBe(true);
    expect(logs.some((message) => message.includes('Recreating panel containers'))).toBe(true);
  });

  it('fails the job (never throws out of apply()) when the broker refuses the fresh re-check at execute time', async () => {
    const broker = Object.assign(new FakeBrokerClient(), {
      panelSelfUpdateCheck: async (): Promise<PanelSelfUpdateCheckResponse> => ({
        serverVersion: null,
        brokerVersion: null,
        updatePossible: false,
        reason: 'The panel containers could not be resolved to a single allowlisted match.',
      }),
    });
    const { service, jobsRepository } = setUp({ broker });

    const { job } = await service.apply({ adminId: null, label: 'admin@example.com' });
    await settle();

    const finished = jobsRepository.getById(job.id);
    expect(finished?.status).toBe('failed');
    expect(finished?.errorMessage).toContain('allowlisted match');
  });

  it('refuses with CONFLICT, before enqueuing, when the release source cannot resolve a latest version', async () => {
    const releaseSource: SelfUpdateReleaseSourcePort = { resolveLatestRelease: async () => null };
    const { service, jobsRepository } = setUp({ releaseSource });
    const before = jobsRepository.list().length;
    await expect(
      service.apply({ adminId: null, label: 'admin@example.com' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(jobsRepository.list().length).toBe(before);
  });
});

describe('PanelSelfUpdateService.readLastResult', () => {
  it('delegates to the status-file reader against its own dataDir', async () => {
    const { service } = setUp();
    await expect(service.readLastResult()).resolves.toBeNull();
  });
});
