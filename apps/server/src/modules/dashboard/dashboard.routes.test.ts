import { describe, expect, it } from 'vitest';
import { FakeBrokerClient } from '../../drivers/broker/fake-broker-client.js';
import { FakeDmsDriver } from '../../drivers/dms/index.js';
import { FakeTlsCertificateSource } from '../../drivers/tls/index.js';
import type { DashboardResponse } from '@dwg/shared';
import { authedInject, loginAs, setUpDashboardApp } from './dashboard-test-harness.js';

describe('GET /api/v1/dashboard', () => {
  it('requires authentication', async () => {
    const { app } = await setUpDashboardApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/dashboard' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('reports every real subsystem healthy on a fresh install, except the one genuine gap: no backup yet', async () => {
    const { app } = await setUpDashboardApp();
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, { method: 'GET', url: '/api/v1/dashboard' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as DashboardResponse;

    // The one honest, non-fabricated gap a brand new install actually has.
    expect(body.verdict.tone).toBe('warning');
    expect(body.verdict.problems).toHaveLength(1);
    expect(body.verdict.problems[0]?.id).toBe('no-recent-verified-backup');
    expect(body.securityExpiry.lastBackupAt).toBeNull();
    expect(body.securityExpiry.lastBackupVerified).toBeNull();

    // Every checkable subsystem otherwise reports real, healthy state —
    // never fabricated, but genuinely healthy against the default fakes.
    for (const signal of body.serviceHealth) {
      expect(signal.state).toBe('healthy');
    }
    expect(body.securityExpiry.tlsState).toBe('healthy');
    expect(body.securityExpiry.tlsExpiryDays).toBeGreaterThan(30);

    // Rspamd/ClamAV/Fail2ban are disabled in FakeDmsDriver's default
    // fixture environment — omitted entirely, never forced into a state
    // (dashboard.ts's own "no control ships that the backend cannot
    // perform" discipline, applied to a read-only chip).
    const serviceHealthIds = body.serviceHealth.map((s) => s.id);
    expect(serviceHealthIds).not.toContain('rspamd');
    expect(serviceHealthIds).not.toContain('clamav');
    expect(serviceHealthIds).not.toContain('fail2ban');
    expect(serviceHealthIds.sort()).toEqual(['broker', 'docker-daemon', 'managed-container']);

    // Metrics genuinely sourced from FakeDmsDriver's own fixtures, not
    // placeholders — matches what listMailboxes/listAliases/listDomains
    // report elsewhere (mailboxes.routes.test.ts et al.).
    expect(body.metrics.mail.state).toBe('ok');
    expect(body.metrics.mail.mailboxCount).toBeGreaterThan(0);
    expect(body.metrics.queue.state).toBe('ok');
    expect(body.metrics.queue.total).toBeGreaterThan(0);
    expect(body.metrics.queue.deferred).toBeGreaterThan(0);
    expect(body.metrics.storage.state).toBe('ok');
    expect(body.metrics.storage.df).not.toBeNull();

    // No samples exist yet — "Collecting", never a fabricated line
    // (rspamd-sampler.ts's own discipline, reused verbatim here).
    expect(body.metrics.spamBlocked.collecting).toBe(true);
    expect(body.metrics.spamBlocked.count).toBeNull();

    // The login this test itself just performed is real, auditable
    // activity — proof this feed reads the real audit_log, not a stub.
    expect(body.recentActivity.some((entry) => entry.action === 'auth.login.success')).toBe(true);

    await app.close();
  });

  it('degrades to Unknown/Critical when the broker is entirely unreachable — never a crash, never fabricated healthy state', async () => {
    const broker = Object.assign(new FakeBrokerClient(), {
      systemPing: async () => {
        throw new Error('connection refused');
      },
      containerInspect: async () => {
        throw new Error('connection refused');
      },
      systemInfo: async () => {
        throw new Error('connection refused');
      },
      systemDf: async () => {
        throw new Error('connection refused');
      },
    });
    const { app } = await setUpDashboardApp({ brokerClient: broker });
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, { method: 'GET', url: '/api/v1/dashboard' });
    expect(response.statusCode).toBe(200); // never a 5xx just because one subsystem is down
    const body = response.json() as DashboardResponse;

    const byId = new Map(body.serviceHealth.map((s) => [s.id, s]));
    expect(byId.get('broker')?.state).toBe('critical');
    expect(byId.get('managed-container')?.state).toBe('unknown');
    expect(byId.get('docker-daemon')?.state).toBe('unknown');
    expect(body.metrics.storage.state).toBe('unknown');
    expect(body.metrics.storage.df).toBeNull();

    expect(body.verdict.tone).toBe('critical');
    const problemIds = body.verdict.problems.map((p) => p.id);
    expect(problemIds).toEqual(
      expect.arrayContaining(['broker', 'managed-container', 'docker-daemon']),
    );

    // Isolation: a broker-only failure must not blank tiles sourced from
    // the (unrelated, still-working) DmsDriver.
    expect(body.metrics.mail.state).toBe('ok');
    expect(body.metrics.mail.mailboxCount).toBeGreaterThan(0);
    expect(body.metrics.queue.state).toBe('ok');

    await app.close();
  });

  it('isolates a DmsDriver-sourced failure to just the queue tile, leaving mail counts (the same driver, a different method) untouched', async () => {
    const driver = Object.assign(new FakeDmsDriver(), {
      getMailQueue: async () => {
        throw new Error('postqueue: command not found');
      },
    });
    const { app } = await setUpDashboardApp({ dmsDriver: driver });
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, { method: 'GET', url: '/api/v1/dashboard' });
    const body = response.json() as DashboardResponse;

    expect(body.metrics.queue.state).toBe('unknown');
    expect(body.metrics.queue.total).toBeNull();
    expect(body.metrics.queue.message).toContain('postqueue');

    expect(body.metrics.mail.state).toBe('ok');
    expect(body.metrics.mail.mailboxCount).toBeGreaterThan(0);

    await app.close();
  });

  it('reports a genuinely unreachable-but-enabled ClamAV as critical, with a real link, and includes it in the verdict', async () => {
    const driver = Object.assign(new FakeDmsDriver(), {
      getCapabilities: async () => ({
        quotas: { supported: true, reason: null },
        rspamd: { supported: false, reason: null },
        clamav: { supported: true, reason: null },
        fail2ban: { supported: false, reason: null },
        accountProvisioner: 'FILE' as const,
        localAccountManagement: { supported: true, reason: null },
      }),
      clamavPing: async () => ({ ok: false as const, reason: 'connection refused' }),
    });
    const { app } = await setUpDashboardApp({ dmsDriver: driver });
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, { method: 'GET', url: '/api/v1/dashboard' });
    const body = response.json() as DashboardResponse;

    const clamav = body.serviceHealth.find((s) => s.id === 'clamav');
    expect(clamav?.state).toBe('critical');
    expect(clamav?.link).toBe('/security/clamav');
    expect(body.verdict.problems.map((p) => p.id)).toContain('clamav');

    await app.close();
  });

  it('reports an unreachable TLS source as Unknown, never a false healthy or a crash', async () => {
    const source = new FakeTlsCertificateSource().setDefault({
      reachable: false,
      der: null,
      error: 'connection timed out',
    });
    const { app } = await setUpDashboardApp({ tlsCertificateSource: source });
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, { method: 'GET', url: '/api/v1/dashboard' });
    const body = response.json() as DashboardResponse;

    expect(body.securityExpiry.tlsState).toBe('unknown');
    expect(body.securityExpiry.tlsExpiryDays).toBeNull();
    expect(body.verdict.problems.map((p) => p.id)).toContain('tls-cert-expiring');

    await app.close();
  });
});
