import { describe, expect, it } from 'vitest';
import { estimatePasswordStrength, generatePassword } from './password-strength';

describe('estimatePasswordStrength', () => {
  it('rates an empty password as very weak', () => {
    expect(estimatePasswordStrength('').score).toBe(0);
  });

  it('rates a short, single-character-class password as weak', () => {
    expect(estimatePasswordStrength('password').score).toBeLessThanOrEqual(1);
  });

  it('rates a long, multi-character-class password as strong', () => {
    const strength = estimatePasswordStrength('Tr0ub4dor&3-Zebra-Canyon-91!');
    expect(strength.score).toBeGreaterThanOrEqual(3);
  });

  it('is monotonically non-decreasing as more character classes are added at a fixed length', () => {
    const lower = estimatePasswordStrength('abcdefghijkl');
    const lowerUpper = estimatePasswordStrength('abcdefghijKL');
    const lowerUpperDigit = estimatePasswordStrength('abcdefghij9L');
    const all = estimatePasswordStrength('abcdefg9#!KL');

    expect(lowerUpper.bits).toBeGreaterThanOrEqual(lower.bits);
    expect(lowerUpperDigit.bits).toBeGreaterThanOrEqual(lowerUpper.bits);
    expect(all.bits).toBeGreaterThanOrEqual(lowerUpperDigit.bits);
  });

  it('is monotonically non-decreasing as length grows for the same character set', () => {
    const short = estimatePasswordStrength('abcabc');
    const long = estimatePasswordStrength('abcabcabcabcabcabc');
    expect(long.bits).toBeGreaterThan(short.bits);
  });

  it('never throws or returns a negative score for unusual input', () => {
    expect(() => estimatePasswordStrength('🔒🔒🔒')).not.toThrow();
    expect(estimatePasswordStrength('🔒🔒🔒').score).toBeGreaterThanOrEqual(0);
  });
});

describe('generatePassword', () => {
  it('generates a password of the requested length', () => {
    expect(generatePassword(24)).toHaveLength(24);
    expect(generatePassword(8)).toHaveLength(8);
  });

  it('defaults to a long, generation-appropriate length', () => {
    expect(generatePassword().length).toBeGreaterThanOrEqual(16);
  });

  it('never includes visually-ambiguous characters (0/O, 1/l/I)', () => {
    const password = generatePassword(500); // large sample to make an omission likely to surface
    expect(password).not.toMatch(/[0O1lI]/);
  });

  it('produces a different password on each call (uses real randomness, not a fixed seed)', () => {
    const a = generatePassword();
    const b = generatePassword();
    expect(a).not.toBe(b);
  });

  it('rates its own output as strong', () => {
    const password = generatePassword();
    expect(estimatePasswordStrength(password).score).toBeGreaterThanOrEqual(3);
  });
});
