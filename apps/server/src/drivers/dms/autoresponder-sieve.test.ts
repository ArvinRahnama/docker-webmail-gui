import { describe, expect, it } from 'vitest';
import { validateSieveScriptContent } from './sieve-validator.js';
import {
  AUTORESPONDER_SCRIPT_NAME,
  generateAutoresponderSieve,
  parseAutoresponderSieve,
} from './autoresponder-sieve.js';

describe('generateAutoresponderSieve', () => {
  it('generates a currentdate window with both bounds, matching the RFC 5260 + RFC 5230 pattern', () => {
    const script = generateAutoresponderSieve({
      subject: 'Out of office',
      message: 'I am away and will respond when I return.',
      startDate: '2026-08-01',
      endDate: '2026-08-15',
    });

    expect(script).toContain('require ["vacation", "date", "relational"];');
    expect(script).toContain('currentdate :zone "+0000" :value "ge" "date" "2026-08-01"');
    expect(script).toContain('currentdate :zone "+0000" :value "le" "date" "2026-08-15"');
    expect(script).toMatch(/if allof\(/);
    expect(script).toContain('vacation :days 7 :subject "Out of office"');
  });

  it('produces a script the security validator accepts (no execute/pipe tokens, within size)', () => {
    const script = generateAutoresponderSieve({
      subject: 'Out of office',
      message: 'Away until further notice.',
      startDate: '2026-08-01',
      endDate: '2026-08-15',
    });
    expect(validateSieveScriptContent(script)).toEqual({ ok: true });
  });

  it('emits only a lower bound when endDate is omitted', () => {
    const script = generateAutoresponderSieve({
      subject: 'Away',
      message: 'Back soon.',
      startDate: '2026-08-01',
    });
    expect(script).toContain('currentdate :zone "+0000" :value "ge" "date" "2026-08-01"');
    expect(script).not.toContain(':value "le"');
    // A single condition is not wrapped in allof().
    expect(script).not.toMatch(/allof/);
    expect(script).toMatch(/^if currentdate/m);
  });

  it('emits only an upper bound when startDate is omitted', () => {
    const script = generateAutoresponderSieve({
      subject: 'Away',
      message: 'Back soon.',
      endDate: '2026-08-15',
    });
    expect(script).toContain('currentdate :zone "+0000" :value "le" "date" "2026-08-15"');
    expect(script).not.toContain(':value "ge"');
  });

  it('degrades to a plain, unwrapped vacation with no date requirement when neither bound is given', () => {
    const script = generateAutoresponderSieve({ subject: 'Away', message: 'Back soon.' });
    expect(script).not.toContain('currentdate');
    expect(script).toContain('require ["vacation"];');
    expect(script).not.toMatch(/^if /m);
  });

  it('rejects a malformed date defensively, even though callers should already validate', () => {
    expect(() =>
      generateAutoresponderSieve({ subject: 'x', message: 'y', startDate: 'not-a-date' }),
    ).toThrow(/ISO date/);
  });

  it('escapes a double quote and backslash in the subject so it cannot break out of the quoted string', () => {
    const script = generateAutoresponderSieve({
      subject: 'Away "on \\ leave"',
      message: 'Back soon.',
    });
    expect(script).toContain('vacation :days 7 :subject "Away \\"on \\\\ leave\\""');
  });

  it('dot-stuffs a message line that begins with a literal dot', () => {
    const script = generateAutoresponderSieve({
      subject: 'Away',
      message: '.this line starts with a dot\nsecond line',
    });
    expect(script).toContain('..this line starts with a dot');
  });
});

describe('parseAutoresponderSieve round-trip', () => {
  it('recovers exactly the structured input a generated script was built from', () => {
    const input = {
      subject: 'Out of office',
      message: 'I am away until 30 August.\nSecond line, with "quotes" and a \\ backslash.',
      startDate: '2026-08-20',
      endDate: '2026-08-30',
    };
    const script = generateAutoresponderSieve(input);
    const parsed = parseAutoresponderSieve(script);
    expect(parsed).toEqual(input);
  });

  it('round-trips null start/end when neither bound was set', () => {
    const script = generateAutoresponderSieve({ subject: 'Away', message: 'Back soon.' });
    const parsed = parseAutoresponderSieve(script);
    expect(parsed?.startDate).toBeNull();
    expect(parsed?.endDate).toBeNull();
  });

  it('returns null (never a guessed partial read) for hand-written Sieve with no recognised header', () => {
    const handWritten = 'require ["fileinto"];\nif true { fileinto "INBOX"; }';
    expect(parseAutoresponderSieve(handWritten)).toBeNull();
  });

  it('returns null for empty content', () => {
    expect(parseAutoresponderSieve('')).toBeNull();
  });

  it('uses a stable, predictable script name', () => {
    expect(AUTORESPONDER_SCRIPT_NAME).toBe('dwg-autoresponder');
  });
});
