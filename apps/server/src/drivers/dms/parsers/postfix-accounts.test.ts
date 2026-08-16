import { describe, expect, it } from 'vitest';
import { parsePostfixAccounts } from './postfix-accounts.js';

describe('parsePostfixAccounts — valid input', () => {
  it('parses a real confirmed example line (docs/research/01-docker-mailserver.md §6)', () => {
    const content =
      'user1@domainone.tld|{SHA512-CRYPT}$6$UMGnThsSm0IFgzEw$BynVshxudpGQHDRQaF4b7wb57A7NazGZcBUakYYLflp7J4E3UHK2qo/C1qXMCkRlYFlTd.SuwCsCKb7zBaUkb/';
    const result = parsePostfixAccounts(content);

    expect(result.issues).toEqual([]);
    expect(result.entries).toEqual([
      {
        email: 'user1@domainone.tld',
        localPart: 'user1',
        domain: 'domainone.tld',
        passwordHash:
          '{SHA512-CRYPT}$6$UMGnThsSm0IFgzEw$BynVshxudpGQHDRQaF4b7wb57A7NazGZcBUakYYLflp7J4E3UHK2qo/C1qXMCkRlYFlTd.SuwCsCKb7zBaUkb/',
        attributes: '',
      },
    ]);
  });

  it('parses multiple accounts across multiple domains', () => {
    const content = [
      'user1@domainone.tld|{SHA512-CRYPT}$6$aaa',
      'user2@domaintwo.tld|{SHA512-CRYPT}$6$bbb',
      'user3@domainone.tld|{SHA512-CRYPT}$6$ccc',
    ].join('\n');
    const result = parsePostfixAccounts(content);

    expect(result.issues).toEqual([]);
    expect(result.entries).toHaveLength(3);
    expect(result.entries.map((e) => e.domain)).toEqual([
      'domainone.tld',
      'domaintwo.tld',
      'domainone.tld',
    ]);
  });

  it('accepts a present third (attributes) field, verbatim', () => {
    const result = parsePostfixAccounts('user@example.com|{SHA512-CRYPT}$6$abc|some-attribute');
    expect(result.entries[0]?.attributes).toBe('some-attribute');
  });

  it('accepts an explicitly empty third field', () => {
    const result = parsePostfixAccounts('user@example.com|{SHA512-CRYPT}$6$abc|');
    expect(result.issues).toEqual([]);
    expect(result.entries[0]?.attributes).toBe('');
  });
});

describe('parsePostfixAccounts — blank lines, comments, whitespace', () => {
  it('skips blank lines without reporting them as issues', () => {
    const content =
      'user1@example.com|{SHA512-CRYPT}$6$aaa\n\n\nuser2@example.com|{SHA512-CRYPT}$6$bbb';
    const result = parsePostfixAccounts(content);
    expect(result.entries).toHaveLength(2);
    expect(result.issues).toEqual([]);
  });

  it('skips whole-line comments without reporting them as issues', () => {
    const content = [
      '# this is a comment',
      'user@example.com|{SHA512-CRYPT}$6$aaa',
      '#another comment, no space',
    ].join('\n');
    const result = parsePostfixAccounts(content);
    expect(result.entries).toHaveLength(1);
    expect(result.issues).toEqual([]);
  });

  it('tolerates trailing whitespace and CRLF line endings', () => {
    const content =
      'user@example.com|{SHA512-CRYPT}$6$aaa   \r\nuser2@example.com|{SHA512-CRYPT}$6$bbb\t\r\n';
    const result = parsePostfixAccounts(content);
    expect(result.issues).toEqual([]);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]?.passwordHash).toBe('{SHA512-CRYPT}$6$aaa');
  });

  it('handles an empty file', () => {
    const result = parsePostfixAccounts('');
    expect(result.entries).toEqual([]);
    expect(result.issues).toEqual([]);
  });
});

describe('parsePostfixAccounts — unicode addresses', () => {
  it('accepts a unicode (IDN/SMTPUTF8) local part and domain', () => {
    const result = parsePostfixAccounts('用户@例え.jp|{SHA512-CRYPT}$6$aaa');
    expect(result.issues).toEqual([]);
    expect(result.entries[0]).toMatchObject({
      email: '用户@例え.jp',
      localPart: '用户',
      domain: '例え.jp',
    });
  });

  it('accepts an accented local part', () => {
    const result = parsePostfixAccounts('josé@example.com|{SHA512-CRYPT}$6$aaa');
    expect(result.issues).toEqual([]);
    expect(result.entries[0]?.localPart).toBe('josé');
  });
});

describe('parsePostfixAccounts — malformed lines are reported, never thrown, never silently dropped', () => {
  it('does not throw on binary garbage or arbitrary junk', () => {
    expect(() => parsePostfixAccounts('\x00\x01\x02not-a-real-line')).not.toThrow();
    expect(() => parsePostfixAccounts('||||||')).not.toThrow();
    expect(() => parsePostfixAccounts('a'.repeat(10_000))).not.toThrow();
  });

  it('reports a line with no pipe delimiter as an issue, not an entry', () => {
    const result = parsePostfixAccounts('this-is-not-pipe-delimited-at-all');
    expect(result.entries).toEqual([]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ line: 1, raw: 'this-is-not-pipe-delimited-at-all' });
  });

  it('reports a line with too many pipe fields as an issue', () => {
    const result = parsePostfixAccounts('user@example.com|hash|attrs|extra|fields');
    expect(result.entries).toEqual([]);
    expect(result.issues).toHaveLength(1);
  });

  it('reports an invalid email (no @) as an issue', () => {
    const result = parsePostfixAccounts('not-an-email|{SHA512-CRYPT}$6$aaa');
    expect(result.entries).toEqual([]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.reason).toContain('not-an-email');
  });

  it('reports an empty hash field as an issue', () => {
    const result = parsePostfixAccounts('user@example.com|');
    expect(result.entries).toEqual([]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.reason).toContain('empty');
  });

  it('preserves the exact 1-based line number and untouched raw text of a bad line among good ones', () => {
    const content = [
      'user1@example.com|{SHA512-CRYPT}$6$aaa',
      'THIS LINE IS BROKEN', // line 2
      'user2@example.com|{SHA512-CRYPT}$6$bbb',
    ].join('\n');
    const result = parsePostfixAccounts(content);

    expect(result.entries).toHaveLength(2);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ line: 2, raw: 'THIS LINE IS BROKEN' });
  });

  it('a bad line never removes an otherwise-valid account from the result (no silent data loss)', () => {
    const content = ['good@example.com|{SHA512-CRYPT}$6$aaa', 'bad-line-here'].join('\n');
    const result = parsePostfixAccounts(content);
    expect(result.entries.map((e) => e.email)).toEqual(['good@example.com']);
    expect(result.issues).toHaveLength(1);
  });
});
