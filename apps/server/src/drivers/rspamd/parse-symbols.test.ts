import { describe, expect, it } from 'vitest';
import { parseRspamdSymbols } from './parse-symbols.js';

describe('parseRspamdSymbols', () => {
  it('parses a flat array of symbol objects', () => {
    const result = parseRspamdSymbols([
      { symbol: 'BAYES_SPAM', score: 3.5, description: 'Bayes spam', group: 'statistics' },
      { name: 'HFILTER_HOSTNAME_UNKNOWN', score: 6, description: null, group: null },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.symbols).toHaveLength(2);
    expect(result.symbols[0]).toEqual({
      name: 'BAYES_SPAM',
      score: 3.5,
      description: 'Bayes spam',
      group: 'statistics',
    });
  });

  it('parses a group-nested object with an array of symbols per group', () => {
    const result = parseRspamdSymbols({
      statistics: { symbols: [{ symbol: 'BAYES_HAM', score: -3, description: null, group: null }] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.symbols).toEqual([
      { name: 'BAYES_HAM', score: -3, description: null, group: null },
    ]);
  });

  it('parses a group-nested object with a symbol-name-keyed map per group', () => {
    const result = parseRspamdSymbols({
      statistics: { symbols: { BAYES_HAM: { score: -3 } } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.symbols[0]?.name).toBe('BAYES_HAM');
    expect(result.symbols[0]?.score).toBe(-3);
  });

  it('parses a flat symbol-name-keyed top-level map', () => {
    const result = parseRspamdSymbols({ BAYES_SPAM: { score: 3.5 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.symbols[0]?.name).toBe('BAYES_SPAM');
  });

  it('never throws, and reports ok:false (not an empty list) for an unrecognised shape', () => {
    expect(() => parseRspamdSymbols('garbage')).not.toThrow();
    expect(() => parseRspamdSymbols(null)).not.toThrow();
    expect(() => parseRspamdSymbols(42)).not.toThrow();

    const result = parseRspamdSymbols('garbage');
    expect(result.ok).toBe(false);
  });

  it('skips entries missing a name or a score rather than fabricating one', () => {
    const result = parseRspamdSymbols([{ symbol: 'NO_SCORE' }, { score: 1 }]);
    expect(result.ok).toBe(false);
  });
});
