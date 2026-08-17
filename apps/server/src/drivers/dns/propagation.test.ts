import { describe, expect, it } from 'vitest';
import { FakeDnsLookupPort } from './fake-resolver.js';
import { checkPropagation, PUBLIC_RESOLVERS } from './propagation.js';

describe('checkPropagation', () => {
  it('queries exactly the fixed public resolver list, never a caller-supplied one', async () => {
    const seen: string[] = [];
    const resolver = new FakeDnsLookupPort().setRecords('example.com', { a: ['203.0.113.1'] });

    const report = await checkPropagation(
      (address) => {
        seen.push(address);
        return resolver;
      },
      'example.com',
      'A',
    );

    expect(seen).toEqual(PUBLIC_RESOLVERS.map((r) => r.address));
    expect(report.results).toHaveLength(PUBLIC_RESOLVERS.length);
    expect(report.caveat.length).toBeGreaterThan(0);
  });

  it('reports per-resolver divergence honestly rather than a single verdict', async () => {
    const agrees = new FakeDnsLookupPort().setRecords('example.com', { a: ['203.0.113.1'] });
    const stale = new FakeDnsLookupPort(); // hasn't seen the new record yet

    const report = await checkPropagation(
      (address) => (address === PUBLIC_RESOLVERS[0]?.address ? stale : agrees),
      'example.com',
      'A',
    );

    const first = report.results[0];
    const rest = report.results.slice(1);
    expect(first?.state).toBe('missing');
    expect(rest.every((r) => r.state === 'detected')).toBe(true);
  });

  it('reports unknown, never invalid, for a resolver that times out', async () => {
    const failing = new FakeDnsLookupPort().setFailure('example.com', 'ETIMEOUT');
    const report = await checkPropagation(() => failing, 'example.com', 'A');
    expect(report.results.every((r) => r.state === 'unknown')).toBe(true);
  });

  it('checks TXT-shaped record types (SPF/DMARC/DKIM) at the correct owner name', async () => {
    const resolver = new FakeDnsLookupPort()
      .setTxt('example.com', 'v=spf1 -all')
      .setTxt('_dmarc.example.com', 'v=DMARC1; p=reject')
      .setTxt('mail._domainkey.example.com', 'v=DKIM1; p=abc');

    const spf = await checkPropagation(() => resolver, 'example.com', 'TXT_SPF');
    const dmarc = await checkPropagation(() => resolver, 'example.com', 'TXT_DMARC');
    const dkim = await checkPropagation(() => resolver, 'example.com', 'TXT_DKIM', 'mail');

    expect(spf.results.every((r) => r.state === 'detected')).toBe(true);
    expect(dmarc.results.every((r) => r.state === 'detected')).toBe(true);
    expect(dkim.results.every((r) => r.state === 'detected')).toBe(true);
  });
});
