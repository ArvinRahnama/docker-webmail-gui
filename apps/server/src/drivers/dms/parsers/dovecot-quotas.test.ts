import { describe, expect, it } from 'vitest';
import { parseDovecotQuotas } from './dovecot-quotas.js';

describe('parseDovecotQuotas — valid input', () => {
  it('parses a real confirmed example line (docs/research/01-docker-mailserver.md §6)', () => {
    const result = parseDovecotQuotas('user@domain:50M');
    expect(result.issues).toEqual([]);
    expect(result.entries).toEqual([
      { email: 'user@domain', localPart: 'user', domain: 'domain', quota: '50M' },
    ]);
  });

  it('parses multiple entries with different units', () => {
    const content = ['a@example.com:50M', 'b@example.com:2G', 'c@example.com:100K'].join('\n');
    const result = parseDovecotQuotas(content);
    expect(result.issues).toEqual([]);
    expect(result.entries.map((e) => e.quota)).toEqual(['50M', '2G', '100K']);
  });

  it('preserves the quota value verbatim without converting to bytes', () => {
    const result = parseDovecotQuotas('user@example.com:12345');
    expect(result.entries[0]?.quota).toBe('12345');
  });
});

describe('parseDovecotQuotas — blank lines, comments, whitespace', () => {
  it('skips blank lines without reporting them as issues', () => {
    const content = 'a@example.com:50M\n\n\nb@example.com:2G';
    const result = parseDovecotQuotas(content);
    expect(result.entries).toHaveLength(2);
    expect(result.issues).toEqual([]);
  });

  it('skips whole-line comments without reporting them as issues', () => {
    const content = ['# comment', 'a@example.com:50M', '#no-space-comment'].join('\n');
    const result = parseDovecotQuotas(content);
    expect(result.entries).toHaveLength(1);
    expect(result.issues).toEqual([]);
  });

  it('tolerates trailing whitespace and CRLF line endings', () => {
    const content = 'a@example.com:50M   \r\nb@example.com:2G\t\r\n';
    const result = parseDovecotQuotas(content);
    expect(result.issues).toEqual([]);
    expect(result.entries).toHaveLength(2);
  });

  it('tolerates whitespace around the colon', () => {
    const result = parseDovecotQuotas('user@example.com : 50M');
    expect(result.issues).toEqual([]);
    expect(result.entries[0]).toMatchObject({ email: 'user@example.com', quota: '50M' });
  });

  it('handles an empty file', () => {
    const result = parseDovecotQuotas('');
    expect(result.entries).toEqual([]);
    expect(result.issues).toEqual([]);
  });
});

describe('parseDovecotQuotas — unicode addresses', () => {
  it('accepts a unicode (IDN/SMTPUTF8) address', () => {
    const result = parseDovecotQuotas('用户@例え.jp:50M');
    expect(result.issues).toEqual([]);
    expect(result.entries[0]).toMatchObject({ localPart: '用户', domain: '例え.jp' });
  });
});

describe('parseDovecotQuotas — malformed lines are reported, never thrown, never silently dropped', () => {
  it('does not throw on binary garbage or arbitrary junk', () => {
    expect(() => parseDovecotQuotas('\x00\x01\x02not-a-real-line')).not.toThrow();
    expect(() => parseDovecotQuotas(':::::')).not.toThrow();
    expect(() => parseDovecotQuotas('a'.repeat(10_000))).not.toThrow();
  });

  it('reports a line with no colon delimiter as an issue, not an entry', () => {
    const result = parseDovecotQuotas('this-has-no-colon-at-all');
    expect(result.entries).toEqual([]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ line: 1, raw: 'this-has-no-colon-at-all' });
  });

  it('reports an invalid email as an issue', () => {
    const result = parseDovecotQuotas('not-an-email:50M');
    expect(result.entries).toEqual([]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.reason).toContain('not-an-email');
  });

  it('reports an empty quota field as an issue', () => {
    const result = parseDovecotQuotas('user@example.com:');
    expect(result.entries).toEqual([]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.reason).toContain('empty');
  });

  it('preserves the exact 1-based line number and untouched raw text of a bad line among good ones', () => {
    const content = [
      'good@example.com:50M',
      'THIS LINE IS BROKEN', // line 2
      'good2@example.com:2G',
    ].join('\n');
    const result = parseDovecotQuotas(content);

    expect(result.entries).toHaveLength(2);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ line: 2, raw: 'THIS LINE IS BROKEN' });
  });

  it('a bad line never removes an otherwise-valid quota entry from the result (no silent data loss)', () => {
    const content = ['good@example.com:50M', 'bad-line-here'].join('\n');
    const result = parseDovecotQuotas(content);
    expect(result.entries.map((e) => e.email)).toEqual(['good@example.com']);
    expect(result.issues).toHaveLength(1);
  });
});
