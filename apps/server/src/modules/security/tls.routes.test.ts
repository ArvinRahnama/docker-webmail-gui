import { X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FakeDmsDriver } from '../../drivers/dms/index.js';
import { FakeTlsCertificateSource, unreachableResult } from '../../drivers/tls/index.js';
import { FIXTURE_CA_SIGNED_CERT } from '../../drivers/tls/fixtures.js';
import { authedInject, loginAs, setUpSecurityApp } from './security-test-harness.js';

describe('/api/v1/security/tls', () => {
  it('requires authentication', async () => {
    const { app } = await setUpSecurityApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/security/tls' });
    expect(response.statusCode).toBe(401);
  });

  it('reports a healthy certificate for every DMS-default endpoint against the fixture source', async () => {
    const { app } = await setUpSecurityApp({
      tlsCertificateSource: new FakeTlsCertificateSource(),
    });
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, { method: 'GET', url: '/api/v1/security/tls' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.endpoints).toHaveLength(5);
    expect(body.endpoints.every((e: { reachable: boolean }) => e.reachable)).toBe(true);
    expect(body.acmeDocsHref).toMatch(/^https:\/\//);
  });

  it('reports unreachable ports as health: unknown, never a fabricated status', async () => {
    const source = new FakeTlsCertificateSource();
    source.setImplicit(465, unreachableResult('Connection refused.'));
    source.setStartTls(25, 'smtp', unreachableResult('Connection refused.'));
    const { app } = await setUpSecurityApp({ tlsCertificateSource: source });
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, { method: 'GET', url: '/api/v1/security/tls' });
    const body = response.json();
    const smtps = body.endpoints.find((e: { protocol: string }) => e.protocol === 'smtps');
    const smtp = body.endpoints.find((e: { protocol: string }) => e.protocol === 'smtp-starttls');
    expect(smtps.reachable).toBe(false);
    expect(smtps.health).toBe('unknown');
    expect(smtps.certificate).toBeNull();
    expect(smtp.reachable).toBe(false);
  });

  it('never returns a private-key-shaped field anywhere in the response', async () => {
    const { app } = await setUpSecurityApp({
      tlsCertificateSource: new FakeTlsCertificateSource(),
    });
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, { method: 'GET', url: '/api/v1/security/tls' });
    expect(JSON.stringify(response.json())).not.toMatch(/PRIVATE KEY/);
  });

  it('reflects SSL_TYPE from the DMS driver', async () => {
    class SslTypeDriver extends FakeDmsDriver {
      override async getSslType(): Promise<string | null> {
        return 'letsencrypt';
      }
    }
    const { app } = await setUpSecurityApp({
      dmsDriver: new SslTypeDriver(),
      tlsCertificateSource: new FakeTlsCertificateSource(),
    });
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, { method: 'GET', url: '/api/v1/security/tls' });
    expect(response.json().sslType).toBe('letsencrypt');
  });

  it('classifies a certificate different from the default fixture correctly (CA-signed, not self-signed)', async () => {
    const der = new X509Certificate(FIXTURE_CA_SIGNED_CERT).raw;
    const source = new FakeTlsCertificateSource();
    source.setImplicit(465, { reachable: true, der, error: null });
    const { app } = await setUpSecurityApp({ tlsCertificateSource: source });
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, { method: 'GET', url: '/api/v1/security/tls' });
    const smtps = response
      .json()
      .endpoints.find((e: { protocol: string }) => e.protocol === 'smtps');
    expect(smtps.certificate.isSelfSigned).toBe(false);
    expect(smtps.certificate.subjectAltNames).toContain('mail.example.com');
  });
});
