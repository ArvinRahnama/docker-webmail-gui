import { describe, expect, it } from 'vitest';
import { FakeDnsLookupPort } from './fake-resolver.js';
import { checkPtr } from './ptr.js';

describe('checkPtr', () => {
  it('reports missing when the domain has no A/AAAA records', async () => {
    const resolver = new FakeDnsLookupPort();
    const result = await checkPtr(resolver, 'example.com');
    expect(result.state).toBe('missing');
    expect(result.addresses).toEqual([]);
  });

  it('reports unknown, never invalid, when forward resolution itself fails', async () => {
    const resolver = new FakeDnsLookupPort().setFailure('example.com', 'ETIMEOUT');
    const result = await checkPtr(resolver, 'example.com');
    expect(result.state).toBe('unknown');
  });

  it('validates when every resolved address has a PTR record', async () => {
    const resolver = new FakeDnsLookupPort()
      .setRecords('example.com', { a: ['203.0.113.10'] })
      .setPtr('203.0.113.10', 'mail.example.com');
    const result = await checkPtr(resolver, 'example.com');
    expect(result.state).toBe('valid');
    expect(result.ptrByAddress['203.0.113.10']).toEqual(['mail.example.com']);
  });

  it('flags a missing PTR record on a resolved address as invalid', async () => {
    const resolver = new FakeDnsLookupPort().setRecords('example.com', { a: ['203.0.113.10'] });
    // No .setPtr(...) call — reverse('203.0.113.10') throws ENOTFOUND (missing).
    const result = await checkPtr(resolver, 'example.com');
    expect(result.state).toBe('invalid');
    expect(result.issues.some((i) => i.message.includes('No PTR'))).toBe(true);
  });

  it('degrades to detected (not invalid) when a reverse lookup fails transiently', async () => {
    const resolver = new FakeDnsLookupPort()
      .setRecords('example.com', { a: ['203.0.113.10'] })
      .setFailure('203.0.113.10', 'ESERVFAIL');
    const result = await checkPtr(resolver, 'example.com');
    expect(result.state).toBe('detected');
  });

  it('combines A and AAAA addresses', async () => {
    const resolver = new FakeDnsLookupPort()
      .setRecords('example.com', { a: ['203.0.113.10'], aaaa: ['2001:db8::1'] })
      .setPtr('203.0.113.10', 'mail.example.com')
      .setPtr('2001:db8::1', 'mail.example.com');
    const result = await checkPtr(resolver, 'example.com');
    expect(result.addresses).toHaveLength(2);
    expect(result.state).toBe('valid');
  });
});
