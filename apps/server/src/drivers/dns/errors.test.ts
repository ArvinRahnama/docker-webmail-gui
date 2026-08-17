import { describe, expect, it } from 'vitest';
import { classifyDnsError, describeDnsError } from './errors.js';

function errnoLike(code: string): NodeJS.ErrnoException {
  const err = new Error(`simulated ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe('classifyDnsError', () => {
  it('classifies authoritative negative answers as missing', () => {
    expect(classifyDnsError(errnoLike('ENOTFOUND'))).toBe('missing');
    expect(classifyDnsError(errnoLike('ENODATA'))).toBe('missing');
  });

  it.each(['ETIMEOUT', 'ESERVFAIL', 'ECONNREFUSED', 'EREFUSED', 'ECANCELLED', 'EBADRESP'])(
    'classifies %s as unknown, never invalid',
    (code) => {
      expect(classifyDnsError(errnoLike(code))).toBe('unknown');
    },
  );

  it('classifies an unrecognised code as unknown (fails toward grey)', () => {
    expect(classifyDnsError(errnoLike('ETOTALLYNEWCODE'))).toBe('unknown');
  });

  it('classifies a non-DNS-shaped error as unknown', () => {
    expect(classifyDnsError(new Error('boom'))).toBe('unknown');
    expect(classifyDnsError('a string, not an error')).toBe('unknown');
    expect(classifyDnsError(null)).toBe('unknown');
  });
});

describe('describeDnsError', () => {
  it('includes the error code when present', () => {
    expect(describeDnsError(errnoLike('ETIMEOUT'))).toContain('ETIMEOUT');
  });

  it('never throws for a non-error input', () => {
    expect(() => describeDnsError(undefined)).not.toThrow();
    expect(describeDnsError(undefined)).toBe('DNS lookup failed');
  });
});
