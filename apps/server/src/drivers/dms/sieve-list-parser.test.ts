import { describe, expect, it } from 'vitest';
import { parseSieveList } from './sieve-list-parser.js';

describe('parseSieveList', () => {
  it('returns an empty list, never throwing, for empty output', () => {
    expect(() => parseSieveList('')).not.toThrow();
    expect(parseSieveList('')).toEqual([]);
    expect(parseSieveList('   \n  ')).toEqual([]);
  });

  it('parses a JSON array of plain strings, marking the active one', () => {
    const result = parseSieveList('["myfilter", "dwg-autoresponder (active)"]');
    expect(result).toEqual([
      { name: 'myfilter', active: false },
      { name: 'dwg-autoresponder', active: true },
    ]);
  });

  it('parses a JSON array of objects under several plausible key spellings', () => {
    const result = parseSieveList(
      JSON.stringify([
        { name: 'filter-one', active: false },
        { script: 'filter-two', is_active: true },
        { scriptname: 'filter-three', isActive: 'true' },
      ]),
    );
    expect(result).toEqual([
      { name: 'filter-one', active: false },
      { name: 'filter-two', active: true },
      { name: 'filter-three', active: true },
    ]);
  });

  it('skips a JSON row with no recognisable name key rather than throwing', () => {
    const result = parseSieveList(JSON.stringify([{ active: true }, { name: 'ok-one' }]));
    expect(result).toEqual([{ name: 'ok-one', active: false }]);
  });

  it('falls back to plain-text, one-name-per-line parsing when the output is not JSON', () => {
    const result = parseSieveList('myfilter\ndwg-autoresponder (active)\n');
    expect(result).toEqual([
      { name: 'myfilter', active: false },
      { name: 'dwg-autoresponder', active: true },
    ]);
  });

  it('recognises an ACTIVE marker case-insensitively with no parentheses', () => {
    const result = parseSieveList('myfilter ACTIVE');
    expect(result).toEqual([{ name: 'myfilter', active: true }]);
  });

  it('does not truncate a script name that legitimately ends in "active" with no separator', () => {
    const result = parseSieveList('proactive-filter');
    expect(result).toEqual([{ name: 'proactive-filter', active: false }]);
  });

  it('never throws on malformed JSON-looking input, falling back to text parsing', () => {
    expect(() => parseSieveList('[not valid json')).not.toThrow();
  });
});
