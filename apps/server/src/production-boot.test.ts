/**
 * The regression this milestone exists to fix: **the server could not
 * start in production.**
 *
 * `RealDmsDriver` reaches docker-mailserver through a `DmsExecPort`, and
 * before M16 no implementation of that port existed — implementing one
 * would have meant giving the broker `exec.run(argv)` and
 * `file.read(path)`, the passthrough AGENT_BRIEF.md §2 forbids. So
 * `createDmsDriver` refused to construct, `buildApp` threw, and the
 * process exited before it ever listened. `APP_MODE=production` is what
 * `docker/compose.yaml` sets and what `installer/install.sh` writes, so
 * every production install hit this: the broker container came up healthy
 * and the web tier crash-looped, and `install.sh` timed out waiting for a
 * health check that could never pass.
 *
 * These tests boot the real `buildApp` in production configuration — no
 * `dmsDriver` override, which is the whole point, since passing one would
 * skip the exact line that used to throw — and assert it reaches a
 * healthy state. They deliberately do not stub `createDmsDriver`.
 *
 * A `BrokerClient` stub stands in for the broker: production selects the
 * *real* driver, and the real driver must be handed a real adapter over
 * some client. Nothing here talks to a Docker daemon.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { HealthResponseSchema } from '@dwg/shared';
import { buildApp } from './app.js';
import { loadConfig } from './platform/config.js';
import { FakeBrokerClient } from './drivers/broker/fake-broker-client.js';
import { RealDmsDriver } from './drivers/dms/real-dms-driver.js';
import { FakeDmsDriver } from './drivers/dms/fake-dms-driver.js';
import { createDmsDriver } from './drivers/dms/create-dms-driver.js';

function testLogger() {
  return pino({ level: 'silent' });
}

/**
 * The minimum a production config demands. `DATA_DIR` points at an
 * in-memory-ish temp path per run so the SQLite file never collides
 * between tests.
 */
function productionEnv(dataDir: string): Record<string, string> {
  return {
    APP_MODE: 'production',
    COOKIE_SECRET: 'c'.repeat(32),
    BROKER_SHARED_SECRET: 'b'.repeat(32),
    BROKER_URL: 'http://broker.invalid:4000',
    DATA_DIR: dataDir,
    BACKUP_DIR: `${dataDir}/backups`,
  };
}

describe('the server boots in production mode', () => {
  it('builds the app and answers /api/v1/health with "ok"', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dwg-prod-boot-'));

    // No `dmsDriver` override on purpose: this is the line that threw.
    const app = await buildApp({
      config: loadConfig(productionEnv(dataDir)),
      logger: testLogger(),
      brokerClient: new FakeBrokerClient(),
    });

    try {
      const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
      expect(response.statusCode).toBe(200);
      const parsed = HealthResponseSchema.safeParse(response.json());
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.status).toBe('ok');
      }
    } finally {
      await app.close();
    }
  });

  it('selects the real DMS driver in production — a fake here would make the boot meaningless', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dwg-prod-driver-'));

    const driver = createDmsDriver(
      loadConfig(productionEnv(dataDir)),
      testLogger(),
      new FakeBrokerClient(),
    );

    expect(driver).toBeInstanceOf(RealDmsDriver);
    expect(driver).not.toBeInstanceOf(FakeDmsDriver);
  });

  it('still serves the SPA fallback and a JSON API 404 in production configuration', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dwg-prod-routes-'));

    const app = await buildApp({
      config: loadConfig(productionEnv(dataDir)),
      logger: testLogger(),
      brokerClient: new FakeBrokerClient(),
    });

    try {
      const missing = await app.inject({ method: 'GET', url: '/api/v1/nope' });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error.code).toBe('NOT_FOUND');
    } finally {
      await app.close();
    }
  });
});
