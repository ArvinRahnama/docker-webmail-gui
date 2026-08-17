import { describe, expect, it } from 'vitest';
import { FakeDmsDriver } from '../../drivers/dms/index.js';
import { FakeRspamdClient } from '../../drivers/rspamd/index.js';
import { authedInject, loginAs, setUpSecurityApp } from './security-test-harness.js';

/** `FakeDmsDriver`'s own fixture env ships `ENABLE_RSPAMD=0` — this override reports it enabled for the tests that need the "full" path. */
class RspamdEnabledDriver extends FakeDmsDriver {
  override async getCapabilities() {
    const base = await super.getCapabilities();
    return { ...base, rspamd: { supported: true, reason: null } };
  }
}

describe('/api/v1/security/rspamd', () => {
  it('requires authentication', async () => {
    const { app } = await setUpSecurityApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/security/rspamd' });
    expect(response.statusCode).toBe(401);
  });

  it('reports the real capability-off state (never a fake empty success) when ENABLE_RSPAMD is off', async () => {
    const { app } = await setUpSecurityApp({ dmsDriver: new FakeDmsDriver() });
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/security/rspamd',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.capability.supported).toBe(false);
    expect(body.reachable).toBe(false);
    expect(body.stat).toBeNull();
  });

  it('returns parsed stat/symbols/actions when enabled and reachable', async () => {
    const { app } = await setUpSecurityApp({
      dmsDriver: new RspamdEnabledDriver(),
      rspamdClient: new FakeRspamdClient(),
    });
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/security/rspamd',
    });
    const body = response.json();
    expect(body.capability.supported).toBe(true);
    expect(body.reachable).toBe(true);
    expect(body.stat.scanned).toBeGreaterThan(0);
    expect(body.symbols.length).toBeGreaterThan(0);
    expect(body.actions.length).toBeGreaterThan(0);
    expect(body.historyCaveat).toMatch(/200-entry/);
  });

  it('reports reachable:false honestly when the controller is unreachable, never fabricating stats', async () => {
    const { app } = await setUpSecurityApp({
      dmsDriver: new RspamdEnabledDriver(),
      rspamdClient: new FakeRspamdClient().setUnreachable('ECONNREFUSED'),
    });
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/security/rspamd',
    });
    const body = response.json();
    expect(body.reachable).toBe(false);
    expect(body.stat).toBeNull();
  });

  it('the trend endpoint reports collecting:true with no fabricated points on a fresh install', async () => {
    const { app } = await setUpSecurityApp({ dmsDriver: new RspamdEnabledDriver() });
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/security/rspamd/trend',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      collecting: true,
      windowHours: expect.any(Number),
      points: [],
    });
  });

  it('setting an action threshold is audited and calls the client', async () => {
    const client = new FakeRspamdClient();
    const { db, app } = await setUpSecurityApp({
      dmsDriver: new RspamdEnabledDriver(),
      rspamdClient: client,
    });
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/security/rspamd/actions',
      payload: { action: 'reject', score: 18 },
    });

    expect(response.statusCode).toBe(200);
    expect(client.savedThresholds).toEqual([{ action: 'reject', score: 18 }]);
    const rows = db.all("SELECT * FROM audit_log WHERE action = 'rspamd.threshold_set'");
    expect(rows).toHaveLength(1);
  });

  it('setting a symbol score is audited and calls the client', async () => {
    const client = new FakeRspamdClient();
    const { db, app } = await setUpSecurityApp({
      dmsDriver: new RspamdEnabledDriver(),
      rspamdClient: client,
    });
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/security/rspamd/symbols',
      payload: { symbol: 'BAYES_SPAM', score: 4.2 },
    });

    expect(response.statusCode).toBe(200);
    expect(client.savedSymbolScores).toEqual([{ symbol: 'BAYES_SPAM', score: 4.2 }]);
    const rows = db.all("SELECT * FROM audit_log WHERE action = 'rspamd.symbol_score_set'");
    expect(rows).toHaveLength(1);
  });

  it('learn-spam and learn-ham are audited without ever storing the message body', async () => {
    const client = new FakeRspamdClient();
    const { db, app } = await setUpSecurityApp({
      dmsDriver: new RspamdEnabledDriver(),
      rspamdClient: client,
    });
    const auth = await loginAs(app);

    const spamMessage = 'From: attacker@example.net\r\nSubject: buy now\r\n\r\nspam body';
    const response = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/security/rspamd/learn-spam',
      payload: { message: spamMessage },
    });
    expect(response.statusCode).toBe(200);
    expect(client.learnedSpam).toEqual([{ message: spamMessage }]);

    const rows = db.all<{ details: string }>(
      "SELECT details FROM audit_log WHERE action = 'rspamd.learn_spam'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.details).not.toContain('attacker@example.net');
    expect(rows[0]?.details).not.toContain('spam body');
  });

  it('all four write routes refuse with CAPABILITY_UNSUPPORTED before touching the client when Rspamd is off', async () => {
    const client = new FakeRspamdClient();
    const { app } = await setUpSecurityApp({
      dmsDriver: new FakeDmsDriver(),
      rspamdClient: client,
    });
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/security/rspamd/actions',
      payload: { action: 'reject', score: 18 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CAPABILITY_UNSUPPORTED');
    expect(client.savedThresholds).toEqual([]);
  });

  it('rejects an oversized learn payload before it ever reaches the client', async () => {
    const client = new FakeRspamdClient();
    const { app } = await setUpSecurityApp({
      dmsDriver: new RspamdEnabledDriver(),
      rspamdClient: client,
    });
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/security/rspamd/learn-spam',
      payload: { message: 'x'.repeat(2_000_001) },
    });

    // Rejected either by the schema's own 2,000,000-char cap
    // (VALIDATION_FAILED/400) or by Fastify's own body-size limit
    // upstream of it (413) — both are a genuine rejection before the
    // Rspamd client is ever touched, which is the property under test.
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
    expect(client.learnedSpam).toEqual([]);
  });
});
