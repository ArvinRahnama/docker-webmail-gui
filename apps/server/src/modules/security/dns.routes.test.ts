import { describe, expect, it } from 'vitest';
import { FakeDnsLookupPort } from '../../drivers/dns/index.js';
import { authedInject, loginAs, setUpSecurityApp } from './security-test-harness.js';

describe('/api/v1/security/dns', () => {
  it('requires authentication', async () => {
    const { app } = await setUpSecurityApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/security/dns/example.com' });
    expect(response.statusCode).toBe(401);
  });

  it('returns a full email-auth report for a valid domain', async () => {
    const resolver = new FakeDnsLookupPort()
      .setRecords('example.com', { mx: [{ exchange: 'mail.example.com', priority: 10 }] })
      .setTxt('example.com', 'v=spf1 mx -all')
      .setTxt('_dmarc.example.com', 'v=DMARC1; p=reject; rua=mailto:r@example.com')
      .setTxt('mail._domainkey.example.com', 'v=DKIM1; k=rsa; p=abc');
    const { app } = await setUpSecurityApp({
      dnsLookupPort: resolver,
      dnsLookupPortFactory: () => resolver,
    });
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/security/dns/example.com',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.domain).toBe('example.com');
    expect(body.mx.state).toBe('valid');
    expect(body.spf.state).toBe('valid');
    expect(body.dmarc.state).toBe('valid');
    expect(body.dkim.state).toBe('valid');
  });

  it('rejects a malformed/injection-shaped domain before ever calling the resolver', async () => {
    const { app } = await setUpSecurityApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: `/api/v1/security/dns/${encodeURIComponent('example.com; rm -rf /')}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('accepts a custom selector query parameter', async () => {
    const resolver = new FakeDnsLookupPort().setTxt(
      'custom._domainkey.example.com',
      'v=DKIM1; k=rsa; p=abc',
    );
    const { app } = await setUpSecurityApp({
      dnsLookupPort: resolver,
      dnsLookupPortFactory: () => resolver,
    });
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/security/dns/example.com?selector=custom',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().dkim.selector).toBe('custom');
  });

  it('propagation endpoint queries the fixed public resolver list and returns per-resolver results', async () => {
    const resolver = new FakeDnsLookupPort().setRecords('example.com', { a: ['203.0.113.1'] });
    const { app } = await setUpSecurityApp({
      dnsLookupPort: resolver,
      dnsLookupPortFactory: () => resolver,
    });
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/security/dns/example.com/propagation?recordType=A',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.recordType).toBe('A');
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results.length).toBeGreaterThanOrEqual(3);
    expect(typeof body.caveat).toBe('string');
  });

  it('rejects an unknown recordType on the propagation endpoint', async () => {
    const { app } = await setUpSecurityApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/security/dns/example.com/propagation?recordType=NOT_A_TYPE',
    });

    expect(response.statusCode).toBe(400);
  });

  it('a resolver failure surfaces as unknown states, not a 5xx crash', async () => {
    const resolver = new FakeDnsLookupPort()
      .setFailure('example.com', 'ETIMEOUT')
      .setFailure('mail._domainkey.example.com', 'ETIMEOUT')
      .setFailure('_dmarc.example.com', 'ETIMEOUT');
    const { app } = await setUpSecurityApp({
      dnsLookupPort: resolver,
      dnsLookupPortFactory: () => resolver,
    });
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/security/dns/example.com',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.mx.state).toBe('unknown');
    expect(body.spf.state).toBe('unknown');
  });
});
