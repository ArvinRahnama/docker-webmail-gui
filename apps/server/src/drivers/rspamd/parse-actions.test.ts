import { describe, expect, it } from 'vitest';
import { parseRspamdActions } from './parse-actions.js';

describe('parseRspamdActions', () => {
  it('parses an array of {action, value} objects', () => {
    const result = parseRspamdActions([
      { action: 'reject', value: 15 },
      { action: 'add header', value: 6 },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.actions).toEqual([
      { action: 'reject', score: 15 },
      { action: 'add header', score: 6 },
    ]);
  });

  it('parses a flat action-name-keyed map', () => {
    const result = parseRspamdActions({ reject: 15, greylist: 4 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.actions).toContainEqual({ action: 'reject', score: 15 });
    expect(result.actions).toContainEqual({ action: 'greylist', score: 4 });
  });

  it('treats a genuinely empty array as a valid empty result, not a parse failure', () => {
    const result = parseRspamdActions([]);
    expect(result).toEqual({ ok: true, actions: [] });
  });

  it('never throws, and reports ok:false for an unrecognised non-empty shape', () => {
    expect(() => parseRspamdActions('garbage')).not.toThrow();
    expect(() => parseRspamdActions(null)).not.toThrow();
    expect(parseRspamdActions('garbage').ok).toBe(false);
    expect(parseRspamdActions([{ irrelevant: true }]).ok).toBe(false);
  });
});
