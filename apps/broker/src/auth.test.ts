import { describe, expect, it } from 'vitest';
import { secretsMatch } from './auth.js';

describe('secretsMatch', () => {
  it('returns true for identical secrets', () => {
    expect(secretsMatch('correct-horse-battery-staple', 'correct-horse-battery-staple')).toBe(true);
  });

  it('returns false for a different secret of the same length', () => {
    expect(secretsMatch('aaaaaaaaaaaaaaaa', 'baaaaaaaaaaaaaaa')).toBe(false);
  });

  it('returns false — never throws — when the provided value is a different length than expected', () => {
    expect(() => secretsMatch('short', 'a-much-longer-expected-secret-value')).not.toThrow();
    expect(secretsMatch('short', 'a-much-longer-expected-secret-value')).toBe(false);
    expect(secretsMatch('', 'non-empty-secret')).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(secretsMatch('Secret', 'secret')).toBe(false);
  });
});
