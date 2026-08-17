import { describe, expect, it } from 'vitest';
import { FakeDnsLookupPort } from './fake-resolver.js';
import { checkSpf } from './spf.js';

describe('checkSpf', () => {
  it('reports missing when no SPF TXT record exists', async () => {
    const resolver = new FakeDnsLookupPort().setTxt('example.com', 'not-an-spf-record');
    const result = await checkSpf(resolver, 'example.com');
    expect(result.state).toBe('missing');
    expect(result.record).toBeNull();
  });

  it('reports missing when the domain has no TXT records at all', async () => {
    const resolver = new FakeDnsLookupPort();
    const result = await checkSpf(resolver, 'example.com');
    expect(result.state).toBe('missing');
  });

  it('reports unknown (never invalid) on a resolver timeout', async () => {
    const resolver = new FakeDnsLookupPort().setFailure('example.com', 'ETIMEOUT');
    const result = await checkSpf(resolver, 'example.com');
    expect(result.state).toBe('unknown');
    expect(result.state).not.toBe('invalid');
  });

  it('validates a simple, well-formed -all record', async () => {
    const resolver = new FakeDnsLookupPort().setTxt(
      'example.com',
      'v=spf1 ip4:203.0.113.0/24 -all',
    );
    const result = await checkSpf(resolver, 'example.com');
    expect(result.state).toBe('valid');
    expect(result.allQualifier).toBe('-all');
    expect(result.lookupCount).toBe(0); // ip4: consumes no DNS lookup
    expect(result.issues.some((i) => i.severity === 'error')).toBe(false);
  });

  it('flags multiple SPF records as invalid', async () => {
    const resolver = new FakeDnsLookupPort().setTxt(
      'example.com',
      'v=spf1 -all',
      'v=spf1 include:_spf.example.net ~all',
    );
    const result = await checkSpf(resolver, 'example.com');
    expect(result.state).toBe('invalid');
    expect(result.allRecords).toHaveLength(2);
    expect(result.issues[0]?.severity).toBe('error');
  });

  it('joins a TXT record split across multiple chunks', async () => {
    const resolver = new FakeDnsLookupPort().setRecords('example.com', {
      txt: [['v=spf1 ', 'ip4:203.0.113.1 ', '-all']],
    });
    const result = await checkSpf(resolver, 'example.com');
    expect(result.state).toBe('valid');
    expect(result.record).toBe('v=spf1 ip4:203.0.113.1 -all');
  });

  it('counts a mechanisms recursively through include chains', async () => {
    const resolver = new FakeDnsLookupPort()
      .setTxt('example.com', 'v=spf1 a mx include:_spf.example.net -all')
      .setTxt(
        '_spf.example.net',
        'v=spf1 include:_spf2.example.net exists:%{i}._spf.example.net -all',
      )
      .setTxt('_spf2.example.net', 'v=spf1 a mx -all');

    const result = await checkSpf(resolver, 'example.com');
    // top: a, mx, include = 3; _spf.example.net: include, exists = 2; _spf2.example.net: a, mx = 2
    expect(result.lookupCount).toBe(7);
    expect(result.state).toBe('valid');
  });

  it('flags a record exceeding the 10-lookup RFC 7208 limit as invalid', async () => {
    const resolver = new FakeDnsLookupPort().setTxt(
      'example.com',
      'v=spf1 a mx ptr exists:x.example.com include:i1.example.com include:i2.example.com include:i3.example.com include:i4.example.com include:i5.example.com include:i6.example.com include:i7.example.com -all',
    );
    // None of the include targets resolve to their own SPF record, so each
    // include itself still counts as one lookup (the mechanism itself is a
    // query) even though the nested record is absent.
    for (const sub of ['i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7']) {
      resolver.setTxt(`${sub}.example.com`, 'not-spf');
    }

    const result = await checkSpf(resolver, 'example.com');
    expect(result.lookupCount).toBeGreaterThan(10);
    expect(result.state).toBe('invalid');
    expect(
      result.issues.some((i) => i.severity === 'error' && i.message.includes('permerror')),
    ).toBe(true);
  });

  it('marks ?all as a warning, not an error', async () => {
    const resolver = new FakeDnsLookupPort().setTxt('example.com', 'v=spf1 ?all');
    const result = await checkSpf(resolver, 'example.com');
    expect(result.allQualifier).toBe('?all');
    expect(result.state).toBe('valid');
    expect(result.issues.some((i) => i.severity === 'warning')).toBe(true);
  });

  it('reports lookupCount as null (not a guess) when a nested lookup fails unexpectedly', async () => {
    const resolver = new FakeDnsLookupPort()
      .setTxt('example.com', 'v=spf1 include:broken.example.net -all')
      .setFailure('broken.example.net', 'ESERVFAIL');
    const result = await checkSpf(resolver, 'example.com');
    expect(result.lookupCount).toBeNull();
    expect(result.state).toBe('detected');
  });
});
