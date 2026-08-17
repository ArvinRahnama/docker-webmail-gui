import { describe, expect, it } from 'vitest';
import { FakeDnsLookupPort } from './fake-resolver.js';
import { checkEmailAuth } from './email-auth.js';

describe('checkEmailAuth', () => {
  it('assembles all five checks for a fully-configured domain', async () => {
    const resolver = new FakeDnsLookupPort()
      .setRecords('example.com', {
        mx: [{ exchange: 'mail.example.com', priority: 10 }],
        a: ['203.0.113.10'],
      })
      .setTxt('example.com', 'v=spf1 mx -all')
      .setTxt('mail._domainkey.example.com', 'v=DKIM1; k=rsa; p=abc')
      .setTxt('_dmarc.example.com', 'v=DMARC1; p=reject; rua=mailto:r@example.com')
      .setPtr('203.0.113.10', 'mail.example.com');

    const result = await checkEmailAuth(resolver, 'example.com');

    expect(result.domain).toBe('example.com');
    expect(result.mx.state).toBe('valid');
    expect(result.spf.state).toBe('valid');
    expect(result.dkim.state).toBe('valid');
    expect(result.dmarc.state).toBe('valid');
    expect(result.ptr.state).toBe('valid');
    expect(typeof result.checkedAt).toBe('string');
  });

  it('degrades independently: one missing record does not affect the others', async () => {
    const resolver = new FakeDnsLookupPort()
      .setRecords('example.com', { mx: [{ exchange: 'mail.example.com', priority: 10 }] })
      .setTxt('example.com', 'v=spf1 mx -all');
    // No DMARC, no DKIM, no A/PTR seeded.

    const result = await checkEmailAuth(resolver, 'example.com');
    expect(result.mx.state).toBe('valid');
    expect(result.spf.state).toBe('valid');
    expect(result.dmarc.state).toBe('missing');
    expect(result.dkim.state).toBe('missing');
    expect(result.ptr.state).toBe('missing');
  });

  it('uses a custom selector when given', async () => {
    const resolver = new FakeDnsLookupPort().setTxt(
      'custom._domainkey.example.com',
      'v=DKIM1; k=rsa; p=abc',
    );
    const result = await checkEmailAuth(resolver, 'example.com', { selector: 'custom' });
    expect(result.dkim.selector).toBe('custom');
    expect(result.dkim.state).toBe('valid');
  });

  it('never throws even when every lookup fails', async () => {
    const resolver = new FakeDnsLookupPort()
      .setFailure('example.com', 'ETIMEOUT')
      .setFailure('mail._domainkey.example.com', 'ETIMEOUT')
      .setFailure('_dmarc.example.com', 'ETIMEOUT');
    const result = await checkEmailAuth(resolver, 'example.com');
    expect(result.mx.state).toBe('unknown');
    expect(result.spf.state).toBe('unknown');
    expect(result.dkim.state).toBe('unknown');
    expect(result.dmarc.state).toBe('unknown');
  });
});
