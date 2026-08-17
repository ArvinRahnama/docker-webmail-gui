import { describe, expect, it } from 'vitest';
import { FakeDnsLookupPort } from './fake-resolver.js';
import { checkDmarc } from './dmarc.js';

describe('checkDmarc', () => {
  it('reports missing when no record exists at _dmarc.<domain>', async () => {
    const resolver = new FakeDnsLookupPort();
    const result = await checkDmarc(resolver, 'example.com');
    expect(result.state).toBe('missing');
  });

  it('reports unknown, never invalid, on a resolver failure', async () => {
    const resolver = new FakeDnsLookupPort().setFailure('_dmarc.example.com', 'ETIMEOUT');
    const result = await checkDmarc(resolver, 'example.com');
    expect(result.state).toBe('unknown');
  });

  it('validates a well-formed enforced record', async () => {
    const resolver = new FakeDnsLookupPort().setTxt(
      '_dmarc.example.com',
      'v=DMARC1; p=reject; rua=mailto:dmarc-reports@example.com; pct=100',
    );
    const result = await checkDmarc(resolver, 'example.com');
    expect(result.state).toBe('valid');
    expect(result.policy).toBe('reject');
    expect(result.hasRua).toBe(true);
    expect(result.pct).toBe(100);
  });

  it('flags p=none as a warning but still structurally valid', async () => {
    const resolver = new FakeDnsLookupPort().setTxt(
      '_dmarc.example.com',
      'v=DMARC1; p=none; rua=mailto:reports@example.com',
    );
    const result = await checkDmarc(resolver, 'example.com');
    expect(result.state).toBe('valid');
    expect(result.policy).toBe('none');
    expect(
      result.issues.some((i) => i.severity === 'warning' && i.message.includes('p=none')),
    ).toBe(true);
  });

  it('flags a missing rua= as a warning', async () => {
    const resolver = new FakeDnsLookupPort().setTxt('_dmarc.example.com', 'v=DMARC1; p=reject');
    const result = await checkDmarc(resolver, 'example.com');
    expect(result.hasRua).toBe(false);
    expect(result.issues.some((i) => i.severity === 'warning' && i.message.includes('rua'))).toBe(
      true,
    );
  });

  it('flags a missing p= tag as invalid', async () => {
    const resolver = new FakeDnsLookupPort().setTxt(
      '_dmarc.example.com',
      'v=DMARC1; rua=mailto:x@example.com',
    );
    const result = await checkDmarc(resolver, 'example.com');
    expect(result.state).toBe('invalid');
  });

  it('flags multiple DMARC records as invalid', async () => {
    const resolver = new FakeDnsLookupPort().setTxt(
      '_dmarc.example.com',
      'v=DMARC1; p=reject',
      'v=DMARC1; p=none',
    );
    const result = await checkDmarc(resolver, 'example.com');
    expect(result.state).toBe('invalid');
    expect(result.record).toBeNull();
  });

  it('rejects malformed pct values without throwing', async () => {
    const resolver = new FakeDnsLookupPort().setTxt(
      '_dmarc.example.com',
      'v=DMARC1; p=reject; pct=not-a-number',
    );
    const result = await checkDmarc(resolver, 'example.com');
    expect(result.state).toBe('invalid');
    expect(result.pct).toBeNull();
  });

  it('ignores non-DMARC TXT records at the same name', async () => {
    const resolver = new FakeDnsLookupPort().setTxt(
      '_dmarc.example.com',
      'some-other-verification-txt-record',
    );
    const result = await checkDmarc(resolver, 'example.com');
    expect(result.state).toBe('missing');
  });
});
