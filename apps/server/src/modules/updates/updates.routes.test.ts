import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { FakeBrokerClient } from '../../drivers/broker/fake-broker-client.js';
import { FakeRegistryClient, FIXTURE_AVAILABLE_DIGEST } from '../../drivers/registry/index.js';
import { FIXTURE_LATEST_VERSION } from '../../drivers/self-update/index.js';
import { createDatabase } from '../../platform/db.js';
import { loadConfig } from '../../platform/config.js';
import { migrations, runMigrations } from '../../platform/migrations/index.js';
import { JobsRepository } from '../../platform/jobs/jobs.repository.js';
import { AdminsRepository } from '../auth/admins.repository.js';
import { hashPassword } from '../auth/password.js';
import {
  authedInject,
  loginAs,
  PRIMARY_EMAIL,
  PRIMARY_PASSWORD,
  setUpUpdatesApp,
  testLogger,
} from './updates-test-harness.js';

const CURRENT_IMAGE = 'ghcr.io/docker-mailserver/docker-mailserver:latest';
/** Matches `FakeBrokerClient.panelSelfUpdateCheck`'s own fixture constant. */
const PANEL_CURRENT_VERSION = '0.2.0';

describe('/api/v1/updates', () => {
  it('requires authentication', async () => {
    const { app } = await setUpUpdatesApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/updates' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('always includes the rollback caveat, unconditionally', async () => {
    const { app } = await setUpUpdatesApp();
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, { method: 'GET', url: '/api/v1/updates' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { rollbackCaveat: string };
    expect(body.rollbackCaveat).toBeTruthy();
    expect(body.rollbackCaveat.length).toBeGreaterThan(20);
    expect(body.rollbackCaveat.toLowerCase()).toContain('cannot undo');
    await app.close();
  });

  it('reports Unknown (available: null), not a crash, when no local image matches the running digest', async () => {
    const { app } = await setUpUpdatesApp();
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, { method: 'GET', url: '/api/v1/updates' });
    const body = response.json() as {
      current: { digest: string | null; repoTags: string[] };
      available: unknown;
      updateAvailable: boolean;
    };
    expect(body.current.digest).toBe(CURRENT_IMAGE);
    expect(body.available).toBeNull();
    expect(body.updateAvailable).toBe(false);
    await app.close();
  });

  it('reports updateAvailable: true when the registry digest differs from the current one', async () => {
    const broker = Object.assign(new FakeBrokerClient(), {
      imageList: async () => [
        { id: CURRENT_IMAGE, repoTags: [CURRENT_IMAGE], sizeBytes: 1, createdAt: 1, labels: {} },
      ],
    });
    const { app } = await setUpUpdatesApp({
      brokerClient: broker,
      registryClient: new FakeRegistryClient(),
    });
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, { method: 'GET', url: '/api/v1/updates' });
    const body = response.json() as {
      current: { digest: string };
      available: { digest: string } | null;
      updateAvailable: boolean;
    };
    expect(body.current.digest).toBe(CURRENT_IMAGE);
    expect(body.available?.digest).toBe(FIXTURE_AVAILABLE_DIGEST);
    expect(body.updateAvailable).toBe(true);
    await app.close();
  });

  it('reports updateAvailable: false when the registry digest matches the current one', async () => {
    const broker = Object.assign(new FakeBrokerClient(), {
      imageList: async () => [
        { id: CURRENT_IMAGE, repoTags: [CURRENT_IMAGE], sizeBytes: 1, createdAt: 1, labels: {} },
      ],
    });
    const registry = { resolveTagDigest: async () => CURRENT_IMAGE };
    const { app } = await setUpUpdatesApp({ brokerClient: broker, registryClient: registry });
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, { method: 'GET', url: '/api/v1/updates' });
    const body = response.json() as { updateAvailable: boolean };
    expect(body.updateAvailable).toBe(false);
    await app.close();
  });

  it('reports available: null (Unknown) when the registry is unreachable, never throwing', async () => {
    const broker = Object.assign(new FakeBrokerClient(), {
      imageList: async () => [
        { id: CURRENT_IMAGE, repoTags: [CURRENT_IMAGE], sizeBytes: 1, createdAt: 1, labels: {} },
      ],
    });
    const registry = { resolveTagDigest: async () => null };
    const { app } = await setUpUpdatesApp({ brokerClient: broker, registryClient: registry });
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, { method: 'GET', url: '/api/v1/updates' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { available: unknown; updateAvailable: boolean };
    expect(body.available).toBeNull();
    expect(body.updateAvailable).toBe(false);
    await app.close();
  });

  it('reflects the real recent-verified-backup gate, not a hardcoded value', async () => {
    const { app } = await setUpUpdatesApp();
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, { method: 'GET', url: '/api/v1/updates' });
    const body = response.json() as { recentVerifiedBackupExists: boolean };
    expect(body.recentVerifiedBackupExists).toBe(false);
    await app.close();
  });
});

describe('POST /api/v1/updates/apply', () => {
  it('always refuses with CAPABILITY_UNSUPPORTED and audits the refusal', async () => {
    const { app, db } = await setUpUpdatesApp();
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/updates/apply',
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CAPABILITY_UNSUPPORTED');

    const rows = db.all<{ action: string }>(
      "SELECT action FROM audit_log WHERE action = 'update.apply_refused'",
    );
    expect(rows).toHaveLength(1);
    await app.close();
  });
});

describe('GET /api/v1/updates/panel', () => {
  it('requires authentication', async () => {
    const { app } = await setUpUpdatesApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/updates/panel' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('reports the auto-resolved latest version, never letting the client choose one', async () => {
    const { app } = await setUpUpdatesApp();
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, { method: 'GET', url: '/api/v1/updates/panel' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      currentVersion: PANEL_CURRENT_VERSION,
      latestVersion: FIXTURE_LATEST_VERSION,
      updateAvailable: true,
      updatePossible: true,
      reason: null,
    });
    await app.close();
  });
});

describe('POST /api/v1/updates/panel/apply', () => {
  it('enqueues a panel.selfUpdate job targeting the auto-resolved release, and audits update.self_update_started', async () => {
    const { app, db } = await setUpUpdatesApp();
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/updates/panel/apply',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { jobId: string };
    expect(body.jobId).toBeTruthy();

    const job = db.get<{ type: string; status: string }>('SELECT * FROM jobs WHERE id = ?', [
      body.jobId,
    ]);
    expect(job?.type).toBe('panel.selfUpdate');

    const auditRows = db.all<{ action: string; target: string | null; details: string }>(
      "SELECT action, target, details FROM audit_log WHERE action = 'update.self_update_started'",
    );
    expect(auditRows).toHaveLength(1);
    expect(JSON.parse(auditRows[0]?.details ?? '{}')).toMatchObject({
      jobId: body.jobId,
      targetVersion: FIXTURE_LATEST_VERSION,
    });
    await app.close();
  });

  it('refuses with 409 CONFLICT while a backup/restore job is in flight (§9.5), without creating a self-update job', async () => {
    const { app, db } = await setUpUpdatesApp();
    const jobsRepository = new JobsRepository(db);
    const running = jobsRepository.insert({
      type: 'backup.create',
      createdByAdminId: null,
      createdByLabel: 'someone@example.com',
      metadata: null,
    });
    jobsRepository.markRunning(running.id);

    const auth = await loginAs(app);
    const response = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/updates/panel/apply',
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CONFLICT');

    const selfUpdateJobs = db.all('SELECT id FROM jobs WHERE type = ?', ['panel.selfUpdate']);
    expect(selfUpdateJobs).toHaveLength(0);
    await app.close();
  });
});

describe('GET /api/v1/updates/panel/last-result', () => {
  it('requires authentication', async () => {
    const { app } = await setUpUpdatesApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/updates/panel/last-result',
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('returns { result: null } when no self-update has run', async () => {
    const { app } = await setUpUpdatesApp();
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/updates/panel/last-result',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ result: null });
    await app.close();
  });

  it('reads a finished status file, clears it, and audits update.self_update_succeeded', async () => {
    const { app, db, dataDir } = await setUpUpdatesApp();
    writeFileSync(
      join(dataDir, 'self-update-result.json'),
      JSON.stringify({
        phase: 'done',
        outcome: 'success',
        fromVersion: '0.2.0',
        toVersion: '0.3.0',
        failedAt: null,
        reason: null,
      }),
    );

    const auth = await loginAs(app);
    const first = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/updates/panel/last-result',
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({
      result: {
        outcome: 'success',
        fromVersion: '0.2.0',
        toVersion: '0.3.0',
        failedAt: null,
        reason: null,
      },
    });

    const auditRows = db.all<{ result: string }>(
      "SELECT result FROM audit_log WHERE action = 'update.self_update_succeeded'",
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.result).toBe('success');

    // Cleared — a second read reports no verdict.
    const second = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/updates/panel/last-result',
    });
    expect(second.json()).toEqual({ result: null });
    await app.close();
  });

  it('audits update.self_update_failed with result: failure for a failed outcome', async () => {
    const { app, db, dataDir } = await setUpUpdatesApp();
    writeFileSync(
      join(dataDir, 'self-update-result.json'),
      JSON.stringify({
        phase: 'done',
        outcome: 'failed',
        fromVersion: null,
        toVersion: '0.3.0',
        failedAt: 'pre-flight',
        reason: 'Could not pull one or both target images.',
      }),
    );

    const auth = await loginAs(app);
    await authedInject(app, auth, { method: 'GET', url: '/api/v1/updates/panel/last-result' });

    const auditRows = db.all<{ action: string; result: string }>(
      "SELECT action, result FROM audit_log WHERE action = 'update.self_update_failed'",
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.result).toBe('failure');
    await app.close();
  });

  it(
    'a stale running panel.selfUpdate job left by a previous process is marked failed by startup ' +
      'recovery, but this endpoint still reports the real verdict from the status file — never the ' +
      "job's own terminal status (docs/design/self-update.md §6)",
    async () => {
      const db = createDatabase(':memory:');
      runMigrations(db, migrations);
      const admins = new AdminsRepository(db);
      admins.create({
        email: PRIMARY_EMAIL,
        passwordHash: await hashPassword(PRIMARY_PASSWORD),
        role: 'administrator',
        forcePasswordChange: false,
      });

      // Simulates a process that was killed mid self-update: a
      // panel.selfUpdate job row left `running`, with no chance to ever
      // report back for itself.
      const jobsRepository = new JobsRepository(db);
      const stale = jobsRepository.insert({
        type: 'panel.selfUpdate',
        createdByAdminId: null,
        createdByLabel: PRIMARY_EMAIL,
        metadata: { targetVersion: '0.3.0' },
      });
      jobsRepository.markRunning(stale.id);

      // The updater itself did finish, though, and left the real verdict
      // behind on the shared volume before the old process was replaced.
      const dataDir = mkdtempSync(join(tmpdir(), 'dwg-updates-stale-job-test-'));
      writeFileSync(
        join(dataDir, 'self-update-result.json'),
        JSON.stringify({
          phase: 'done',
          outcome: 'success',
          fromVersion: '0.2.0',
          toVersion: '0.3.0',
          failedAt: null,
          reason: null,
        }),
      );

      // Booting the app (no `jobRunner` override) runs
      // `createJobRunner`'s startup recovery sweep against the row seeded
      // above, exactly as a real restart would.
      const config = loadConfig({ DATA_DIR: dataDir });
      const app = await buildApp({ config, logger: testLogger(), db });

      const recovered = db.get<{ status: string; error_message: string | null }>(
        'SELECT status, error_message FROM jobs WHERE id = ?',
        [stale.id],
      );
      expect(recovered?.status).toBe('failed');
      expect(recovered?.error_message).toContain('Interrupted');

      const auth = await loginAs(app, PRIMARY_EMAIL, PRIMARY_PASSWORD);
      const response = await authedInject(app, auth, {
        method: 'GET',
        url: '/api/v1/updates/panel/last-result',
      });
      expect(response.statusCode).toBe(200);
      // The real verdict — success — not the interrupted job's own status.
      expect(response.json()).toEqual({
        result: {
          outcome: 'success',
          fromVersion: '0.2.0',
          toVersion: '0.3.0',
          failedAt: null,
          reason: null,
        },
      });

      const auditRows = db.all(
        "SELECT id FROM audit_log WHERE action = 'update.self_update_succeeded'",
      );
      expect(auditRows).toHaveLength(1);
      await app.close();
    },
  );
});
