import { describe, expect, it } from 'vitest';
import { ERROR_CODES, isErrorCode } from './errors.js';

describe('ERROR_CODES', () => {
  it('contains exactly the documented minimum set, with no duplicates', () => {
    const expected = [
      'VALIDATION_FAILED',
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'NOT_FOUND',
      'CONFLICT',
      'RATE_LIMITED',
      'UPSTREAM_UNAVAILABLE',
      'INTERNAL',
      'INVALID_CREDENTIALS',
      'PASSWORD_CHANGE_REQUIRED',
    ];
    expect([...ERROR_CODES].sort()).toEqual([...expected].sort());
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });
});

describe('isErrorCode', () => {
  it('accepts every known code', () => {
    for (const code of ERROR_CODES) {
      expect(isErrorCode(code)).toBe(true);
    }
  });

  it('rejects unknown strings and non-string values', () => {
    expect(isErrorCode('NOT_A_REAL_CODE')).toBe(false);
    expect(isErrorCode('')).toBe(false);
    expect(isErrorCode(123)).toBe(false);
    expect(isErrorCode(null)).toBe(false);
    expect(isErrorCode(undefined)).toBe(false);
    expect(isErrorCode({ code: 'INTERNAL' })).toBe(false);
  });
});
