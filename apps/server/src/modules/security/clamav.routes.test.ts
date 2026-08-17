import { describe, expect, it } from 'vitest';
import { FakeDmsDriver } from '../../drivers/dms/index.js';
import type { ClamavReadResult } from '../../drivers/dms/types.js';
import { authedInject, loginAs, setUpSecurityApp } from './security-test-harness.js';

/** `FakeDmsDriver`'s own fixture env ships `ENABLE_CLAMAV=0` — this override reports it enabled, mirroring `rspamd.routes.test.ts`'s `RspamdEnabledDriver`. */
class ClamavEnabledDriver extends FakeDmsDriver {
  override async getCapabilities() {
    const base = await super.getCapabilities();
    return { ...base, clamav: { supported: true, reason: null } };
  }
}

/** Additionally simulates an unreachable clamd (e.g. `socat`/the control socket unavailable) — a routine, expected state the service must render as `reachable: false`, never an HTTP error. */
class ClamavUnreachableDriver extends ClamavEnabledDriver {
  override async clamavPing(): Promise<ClamavReadResult> {
    return { ok: false, reason: 'ECONNREFUSED' };
  }
}

/** Simulates the exec itself succeeding (e.g. `socat` connected fine) while whatever answered is not actually clamd — `reachable` must key off the reply content, not just the exit code. */
class ClamavGarbledPingDriver extends ClamavEnabledDriver {
  override async clamavPing(): Promise<ClamavReadResult> {
    return { ok: true, output: '' };
  }
}

describe('/api/v1/security/clamav', () => {
  it('requires authentication', async () => {
    const { app } = await setUpSecurityApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/security/clamav' });
    expect(response.statusCode).toBe(401);
  });

  it('reports the real capability-off state (never a fake empty success) when ENABLE_CLAMAV is off', async () => {
    const { app } = await setUpSecurityApp({ dmsDriver: new FakeDmsDriver() });
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/security/clamav',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.capability.supported).toBe(false);
    expect(body.reachable).toBe(false);
    expect(body.version).toBeNull();
    expect(body.stats).toBeNull();
  });

  it('returns version and raw stats when enabled and reachable', async () => {
    const { app } = await setUpSecurityApp({ dmsDriver: new ClamavEnabledDriver() });
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/security/clamav',
    });
    const body = response.json();
    expect(body.capability.supported).toBe(true);
    expect(body.reachable).toBe(true);
    expect(body.version).toMatch(/ClamAV/);
    expect(typeof body.stats).toBe('string');
  });

  it('reports reachable:false honestly when clamd is unreachable, never fabricating a version', async () => {
    const { app } = await setUpSecurityApp({ dmsDriver: new ClamavUnreachableDriver() });
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/security/clamav',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.reachable).toBe(false);
    expect(body.error).toBe('ECONNREFUSED');
    expect(body.version).toBeNull();
    expect(body.stats).toBeNull();
  });

  it('reports reachable:false when the exec succeeds but the reply is not a real PONG', async () => {
    const { app } = await setUpSecurityApp({ dmsDriver: new ClamavGarbledPingDriver() });
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/security/clamav',
    });
    const body = response.json();
    expect(body.reachable).toBe(false);
    expect(body.version).toBeNull();
  });

  it('detections are labelled log-derived with a stated window, never a bare number', async () => {
    const { app } = await setUpSecurityApp({ dmsDriver: new ClamavEnabledDriver() });
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/security/clamav/detections',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.available).toBe(true);
    expect(typeof body.count).toBe('number');
    expect(body.windowDescription).toMatch(/log/i);
  });

  it('detections report unavailable, never a fabricated zero, when ClamAV is off', async () => {
    const { app } = await setUpSecurityApp({ dmsDriver: new FakeDmsDriver() });
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/security/clamav/detections',
    });
    const body = response.json();
    expect(body.available).toBe(false);
    expect(body.count).toBeNull();
    expect(body.windowDescription).toBeNull();
  });

  it('triggering a signature update is audited', async () => {
    const { db, app } = await setUpSecurityApp({ dmsDriver: new ClamavEnabledDriver() });
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/security/clamav/update',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().triggered).toBe(true);
    const rows = db.all("SELECT * FROM audit_log WHERE action = 'clamav.signature_update'");
    expect(rows).toHaveLength(1);
  });

  it('refuses a signature update with CAPABILITY_UNSUPPORTED before touching the driver when ClamAV is off', async () => {
    const { app } = await setUpSecurityApp({ dmsDriver: new FakeDmsDriver() });
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/security/clamav/update',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CAPABILITY_UNSUPPORTED');
  });
});
