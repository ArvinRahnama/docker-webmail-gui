import { describe, expect, it } from 'vitest';
import { FakeBrokerClient } from '../../drivers/broker/fake-broker-client.js';
import { FakeRegistryClient, FIXTURE_AVAILABLE_DIGEST } from '../../drivers/registry/index.js';
import { authedInject, loginAs, setUpUpdatesApp } from './updates-test-harness.js';

const CURRENT_IMAGE = 'ghcr.io/docker-mailserver/docker-mailserver:latest';

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
