import { describe, expect, it } from 'vitest';
import { isRestrictAction, parsePostfixAccess } from './postfix-access.js';

describe('parsePostfixAccess — valid input', () => {
  it('parses a REJECT entry written by "setup email restrict add"', () => {
    const result = parsePostfixAccess('user@example.com REJECT');
    expect(result.issues).toEqual([]);
    expect(result.entries).toEqual([
      { email: 'user@example.com', localPart: 'user', domain: 'example.com', action: 'REJECT' },
    ]);
  });

  it('tolerates extra whitespace between the pattern and the action', () => {
    const result = parsePostfixAccess('user@example.com    REJECT');
    expect(result.issues).toEqual([]);
    expect(result.entries[0]?.action).toBe('REJECT');
  });

  it('parses multiple lines across multiple domains', () => {
    const content = ['a@domainone.tld REJECT', 'b@domaintwo.tld REJECT'].join('\n');
    const result = parsePostfixAccess(content);
    expect(result.issues).toEqual([]);
    expect(result.entries.map((e) => e.domain)).toEqual(['domainone.tld', 'domaintwo.tld']);
  });

  it('preserves a non-REJECT action verbatim (a hand-edited access file is still valid Postfix syntax)', () => {
    const result = parsePostfixAccess('user@example.com OK');
    expect(result.issues).toEqual([]);
    expect(result.entries[0]?.action).toBe('OK');
  });
});

describe('parsePostfixAccess — blank lines, comments, non-address patterns', () => {
  it('skips blank lines and whole-line comments without reporting them as issues', () => {
    const content = ['# comment', '', 'user@example.com REJECT', '   '].join('\n');
    const result = parsePostfixAccess(content);
    expect(result.entries).toHaveLength(1);
    expect(result.issues).toEqual([]);
  });

  it('silently skips a pattern that is not a full email address (a bare domain/IP access rule this feature did not write)', () => {
    const content = ['example.com REJECT', '192.0.2.0/24 REJECT', 'user@example.com REJECT'].join(
      '\n',
    );
    const result = parsePostfixAccess(content);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.email).toBe('user@example.com');
    expect(result.issues).toEqual([]);
  });

  it('handles an empty file', () => {
    const result = parsePostfixAccess('');
    expect(result.entries).toEqual([]);
    expect(result.issues).toEqual([]);
  });
});

describe('parsePostfixAccess — malformed lines are reported, never thrown, never silently dropped', () => {
  it('does not throw on binary garbage or arbitrary junk', () => {
    expect(() => parsePostfixAccess('\x00\x01\x02not-a-real-line')).not.toThrow();
    expect(() => parsePostfixAccess('a'.repeat(10_000))).not.toThrow();
  });

  it('reports a single-token line (no action field) as an issue', () => {
    const result = parsePostfixAccess('user@example.com');
    expect(result.entries).toEqual([]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ line: 1, raw: 'user@example.com' });
  });

  it('a bad line never removes an otherwise-valid entry from the result', () => {
    const content = ['user@example.com REJECT', 'onetoken'].join('\n');
    const result = parsePostfixAccess(content);
    expect(result.entries.map((e) => e.email)).toEqual(['user@example.com']);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.line).toBe(2);
  });
});

describe('isRestrictAction', () => {
  it('is true for REJECT in any case', () => {
    expect(isRestrictAction('REJECT')).toBe(true);
    expect(isRestrictAction('reject')).toBe(true);
    expect(isRestrictAction('Reject')).toBe(true);
  });

  it('is false for any other action', () => {
    expect(isRestrictAction('OK')).toBe(false);
    expect(isRestrictAction('DUNNO')).toBe(false);
    expect(isRestrictAction('550')).toBe(false);
  });
});
