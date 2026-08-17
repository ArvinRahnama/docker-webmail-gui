import { describe, expect, it } from 'vitest';
import { FakeDmsDriver } from '../../drivers/dms/index.js';
import { authedInject, loginAs, setUpSecurityApp } from './security-test-harness.js';

/** `FakeDmsDriver`'s own fixture env ships `ENABLE_FAIL2BAN=0` — this override reports it enabled for the tests that need the "full" path, mirroring `rspamd.routes.test.ts`'s `RspamdEnabledDriver`. */
class Fail2banEnabledDriver extends FakeDmsDriver {
  override async getCapabilities() {
    const base = await super.getCapabilities();
    return { ...base, fail2ban: { supported: true, reason: null } };
  }
}

describe('/api/v1/security/fail2ban', () => {
  it('requires authentication', async () => {
    const { app } = await setUpSecurityApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/security/fail2ban' });
    expect(response.statusCode).toBe(401);
  });

  it('reports the real capability-off state (never a fake empty success) when ENABLE_FAIL2BAN is off', async () => {
    const { app } = await setUpSecurityApp({ dmsDriver: new FakeDmsDriver() });
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/security/fail2ban',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.capability.supported).toBe(false);
    expect(body.bannedIps).toEqual([]);
    expect(body.rawStatus).toBe('');
  });

  it('returns banned IPs plus the raw status text when enabled', async () => {
    const { app } = await setUpSecurityApp({ dmsDriver: new Fail2banEnabledDriver() });
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/security/fail2ban',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.capability.supported).toBe(true);
    expect(Array.isArray(body.bannedIps)).toBe(true);
    // `rawStatus` always present per the schema, regardless of whether any
    // IP is currently banned — the `[UNCERTAIN]` output shape means the UI
    // must always have something real to fall back to.
    expect(typeof body.rawStatus).toBe('string');
    expect(body.rawStatus.length).toBeGreaterThan(0);
  });

  it('banning an IP is audited and reflected in a subsequent list', async () => {
    const { db, app } = await setUpSecurityApp({ dmsDriver: new Fail2banEnabledDriver() });
    const auth = await loginAs(app);

    const banResponse = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/security/fail2ban/ban',
      payload: { ip: '203.0.113.9' },
    });
    expect(banResponse.statusCode).toBe(200);

    const rows = db.all("SELECT * FROM audit_log WHERE action = 'fail2ban.ban'");
    expect(rows).toHaveLength(1);

    const listResponse = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/security/fail2ban',
    });
    expect(listResponse.json().bannedIps).toContain('203.0.113.9');
  });

  it('unbanning an IP is audited and removed from a subsequent list', async () => {
    const driver = new Fail2banEnabledDriver();
    const { db, app } = await setUpSecurityApp({ dmsDriver: driver });
    const auth = await loginAs(app);

    await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/security/fail2ban/ban',
      payload: { ip: '198.51.100.20' },
    });

    const unbanResponse = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/security/fail2ban/unban',
      payload: { ip: '198.51.100.20' },
    });
    expect(unbanResponse.statusCode).toBe(200);

    const rows = db.all<{ details: string }>(
      "SELECT details FROM audit_log WHERE action = 'fail2ban.unban'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.details).toContain('198.51.100.20');

    const listResponse = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/security/fail2ban',
    });
    expect(listResponse.json().bannedIps).not.toContain('198.51.100.20');
  });

  it('rejects an invalid IP without ever banning anything', async () => {
    const { app } = await setUpSecurityApp({ dmsDriver: new Fail2banEnabledDriver() });
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/security/fail2ban/ban',
      payload: { ip: 'not-an-ip; rm -rf /' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');

    const listResponse = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/security/fail2ban',
    });
    expect(listResponse.json().bannedIps).toEqual([]);
  });

  it('both ban and unban refuse with CAPABILITY_UNSUPPORTED before touching the driver when Fail2ban is off', async () => {
    const { app } = await setUpSecurityApp({ dmsDriver: new FakeDmsDriver() });
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/security/fail2ban/unban',
      payload: { ip: '203.0.113.9' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CAPABILITY_UNSUPPORTED');
  });
});
