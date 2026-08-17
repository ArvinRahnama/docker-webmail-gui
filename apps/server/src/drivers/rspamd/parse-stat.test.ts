import { describe, expect, it } from 'vitest';
import { parseRspamdStat } from './parse-stat.js';

describe('parseRspamdStat', () => {
  it('parses the confirmed minimal shape from research', () => {
    const result = parseRspamdStat({
      scanned: 120,
      learned: 40,
      connections: 3,
      control_connections: 1,
    });
    expect(result.scanned).toBe(120);
    expect(result.learned).toBe(40);
  });

  it('parses ham_count/spam_count and an actions breakdown when present', () => {
    const result = parseRspamdStat({
      scanned: 10,
      learned: 2,
      ham_count: 7,
      spam_count: 3,
      actions: { 'no action': 6, 'add header': 3, reject: 1 },
    });
    expect(result.hamCount).toBe(7);
    expect(result.spamCount).toBe(3);
    expect(result.actions).toEqual({ 'no action': 6, 'add header': 3, reject: 1 });
  });

  it('never throws and reports every field as null for an unrecognised shape', () => {
    expect(() => parseRspamdStat('not an object')).not.toThrow();
    expect(() => parseRspamdStat(null)).not.toThrow();
    expect(() => parseRspamdStat(undefined)).not.toThrow();
    expect(() => parseRspamdStat([1, 2, 3])).not.toThrow();

    const result = parseRspamdStat('garbage');
    expect(result).toEqual({
      scanned: null,
      learned: null,
      hamCount: null,
      spamCount: null,
      actions: {},
    });
  });

  it('ignores non-numeric action values rather than guessing', () => {
    const result = parseRspamdStat({ actions: { reject: 'not-a-number', greylist: 5 } });
    expect(result.actions).toEqual({ greylist: 5 });
  });

  it('reports a missing field as null, never a fabricated 0', () => {
    const result = parseRspamdStat({ scanned: 5 });
    expect(result.learned).toBeNull();
    expect(result.hamCount).toBeNull();
    expect(result.spamCount).toBeNull();
  });
});
