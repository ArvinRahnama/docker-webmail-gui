import { describe, expect, it } from 'vitest';
import { FakeDnsLookupPort } from './fake-resolver.js';
import { checkDkimDns } from './dkim-dns.js';

describe('checkDkimDns', () => {
  it('reports missing when no record exists at the selector', async () => {
    const resolver = new FakeDnsLookupPort();
    const result = await checkDkimDns(resolver, 'example.com', 'mail');
    expect(result.state).toBe('missing');
    expect(result.selector).toBe('mail');
  });

  it('reports unknown, never invalid, on a resolver failure', async () => {
    const resolver = new FakeDnsLookupPort().setFailure('mail._domainkey.example.com', 'ESERVFAIL');
    const result = await checkDkimDns(resolver, 'example.com', 'mail');
    expect(result.state).toBe('unknown');
  });

  it('validates a well-formed record', async () => {
    const resolver = new FakeDnsLookupPort().setTxt(
      'mail._domainkey.example.com',
      'v=DKIM1; h=sha256; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC1',
    );
    const result = await checkDkimDns(resolver, 'example.com', 'mail');
    expect(result.state).toBe('valid');
    expect(result.record).toContain('p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC1');
  });

  it('accepts a record without an explicit v=DKIM1 tag (optional per RFC 6376)', async () => {
    const resolver = new FakeDnsLookupPort().setTxt(
      'mail._domainkey.example.com',
      'k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC1',
    );
    const result = await checkDkimDns(resolver, 'example.com', 'mail');
    expect(result.state).toBe('valid');
  });

  it('flags an empty p= tag as a revoked-key warning, still valid shape', async () => {
    const resolver = new FakeDnsLookupPort().setTxt(
      'mail._domainkey.example.com',
      'v=DKIM1; k=rsa; p=',
    );
    const result = await checkDkimDns(resolver, 'example.com', 'mail');
    expect(result.state).toBe('valid');
    expect(result.issues.some((i) => i.message.toLowerCase().includes('revoked'))).toBe(true);
  });

  it('flags a record missing the p= tag entirely as invalid', async () => {
    const resolver = new FakeDnsLookupPort().setTxt(
      'mail._domainkey.example.com',
      'v=DKIM1; k=rsa',
    );
    const result = await checkDkimDns(resolver, 'example.com', 'mail');
    expect(result.state).toBe('invalid');
  });

  it('uses the given selector to build the query name', async () => {
    const resolver = new FakeDnsLookupPort().setTxt(
      'selector2._domainkey.example.com',
      'v=DKIM1; k=rsa; p=abc',
    );
    const result = await checkDkimDns(resolver, 'example.com', 'selector2');
    expect(result.state).toBe('valid');
  });
});
