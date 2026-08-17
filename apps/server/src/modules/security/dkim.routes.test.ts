import { describe, expect, it } from 'vitest';
import { FakeDmsDriver } from '../../drivers/dms/index.js';
import { FakeDnsLookupPort } from '../../drivers/dns/index.js';
import { authedInject, loginAs, setUpSecurityApp } from './security-test-harness.js';

describe('/api/v1/security/dkim', () => {
  it('requires authentication', async () => {
    const { app } = await setUpSecurityApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/security/dkim/example.com' });
    expect(response.statusCode).toBe(401);
  });

  it('reports not-generated (no publicRecord) before any key exists', async () => {
    const { app } = await setUpSecurityApp({
      dmsDriver: new FakeDmsDriver(),
      dnsLookupPort: new FakeDnsLookupPort(),
      dnsLookupPortFactory: () => new FakeDnsLookupPort(),
    });
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/security/dkim/example.com',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status.publicRecord).toBeNull();
    expect(body.status.matchesDns).toBeNull();
  });

  it('rejects an injection-shaped domain before ever touching the driver', async () => {
    const { app } = await setUpSecurityApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: `/api/v1/security/dkim/${encodeURIComponent('example.com; rm -rf /')}`,
    });

    expect(response.statusCode).toBe(400);
  });

  it('generate creates a key, returns only a public record, and is audited', async () => {
    const { db, app } = await setUpSecurityApp({
      dmsDriver: new FakeDmsDriver(),
      dnsLookupPort: new FakeDnsLookupPort(),
      dnsLookupPortFactory: () => new FakeDnsLookupPort(),
    });
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/security/dkim/example.com/generate',
      payload: { selector: 'mail', keysize: 2048 },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status.publicRecord.name).toBe('mail._domainkey.example.com');
    expect(body.status.publicRecord.value).toMatch(/^v=DKIM1/);
    expect(JSON.stringify(body)).not.toContain('PRIVATE KEY');

    const auditRows = db.all<{ action: string; details: string }>(
      "SELECT action, details FROM audit_log WHERE action = 'dkim.generate'",
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.details).not.toContain('p=');
  });

  it('rejects a malformed selector on generate before calling the driver', async () => {
    const { app } = await setUpSecurityApp({ dmsDriver: new FakeDmsDriver() });
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/security/dkim/example.com/generate',
      payload: { selector: 'bad selector; rm -rf' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('verify: matchesDns is true once DNS publishes the same key the driver generated', async () => {
    const dmsDriver = new FakeDmsDriver();
    const resolver = new FakeDnsLookupPort();
    const { app } = await setUpSecurityApp({
      dmsDriver,
      dnsLookupPort: resolver,
      dnsLookupPortFactory: () => resolver,
    });
    const auth = await loginAs(app);

    const generateResponse = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/security/dkim/example.com/generate',
      payload: {},
    });
    const publishedValue = generateResponse.json().status.publicRecord.value as string;

    // Not yet published in DNS.
    const beforePublish = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/security/dkim/example.com',
    });
    expect(beforePublish.json().status.matchesDns).toBeNull();
    expect(beforePublish.json().status.dnsCheck.state).toBe('missing');

    // Admin publishes it in their real DNS — simulated by seeding the fake resolver.
    resolver.setTxt('mail._domainkey.example.com', publishedValue);

    const afterPublish = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/security/dkim/example.com',
    });
    expect(afterPublish.json().status.matchesDns).toBe(true);
    expect(afterPublish.json().status.dnsCheck.state).toBe('valid');
  });

  it('verify: matchesDns is false when DNS publishes a different key', async () => {
    const dmsDriver = new FakeDmsDriver();
    const resolver = new FakeDnsLookupPort();
    const { app } = await setUpSecurityApp({
      dmsDriver,
      dnsLookupPort: resolver,
      dnsLookupPortFactory: () => resolver,
    });
    const auth = await loginAs(app);

    await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/security/dkim/example.com/generate',
      payload: {},
    });
    resolver.setTxt('mail._domainkey.example.com', 'v=DKIM1; k=rsa; p=SomeOtherUnrelatedKey');

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/security/dkim/example.com',
    });
    expect(response.json().status.matchesDns).toBe(false);
  });
});
