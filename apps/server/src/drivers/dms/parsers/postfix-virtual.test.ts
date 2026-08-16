import { describe, expect, it } from 'vitest';
import { parsePostfixVirtual } from './postfix-virtual.js';

describe('parsePostfixVirtual — valid input', () => {
  it('parses a real confirmed example line (docs/research/01-docker-mailserver.md §6)', () => {
    const result = parsePostfixVirtual('alias2@localhost.localdomain external1@otherdomain.tld');
    expect(result.issues).toEqual([]);
    expect(result.entries).toEqual([
      {
        address: 'alias2@localhost.localdomain',
        isCatchAll: false,
        localPart: 'alias2',
        domain: 'localhost.localdomain',
        recipients: ['external1@otherdomain.tld'],
      },
    ]);
  });

  it('parses comma-joined multiple recipients', () => {
    const result = parsePostfixVirtual('team@example.com alice@example.com,bob@example.com');
    expect(result.issues).toEqual([]);
    expect(result.entries[0]?.recipients).toEqual(['alice@example.com', 'bob@example.com']);
  });

  it('tolerates whitespace-separated recipients as well as comma-joined', () => {
    const result = parsePostfixVirtual('team@example.com alice@example.com bob@example.com');
    expect(result.issues).toEqual([]);
    expect(result.entries[0]?.recipients).toEqual(['alice@example.com', 'bob@example.com']);
  });

  it('parses a catch-all (@domain) left-hand side', () => {
    const result = parsePostfixVirtual('@example.com catchall@example.com');
    expect(result.issues).toEqual([]);
    expect(result.entries[0]).toMatchObject({
      address: '@example.com',
      isCatchAll: true,
      localPart: '',
      domain: 'example.com',
    });
  });

  it('a recipient can be a fully external address (forwarding is the same mechanism, FEATURE_MATRIX.md §5)', () => {
    const result = parsePostfixVirtual('forward@example.com externaluser@gmail.com');
    expect(result.issues).toEqual([]);
    expect(result.entries[0]?.recipients).toEqual(['externaluser@gmail.com']);
  });

  it('parses multiple lines across multiple domains', () => {
    const content = [
      'a@domainone.tld x@external.tld',
      'b@domaintwo.tld y@external.tld',
      '@domainthree.tld z@external.tld',
    ].join('\n');
    const result = parsePostfixVirtual(content);
    expect(result.issues).toEqual([]);
    expect(result.entries).toHaveLength(3);
    expect(result.entries.map((e) => e.domain)).toEqual([
      'domainone.tld',
      'domaintwo.tld',
      'domainthree.tld',
    ]);
  });
});

describe('parsePostfixVirtual — blank lines, comments, whitespace', () => {
  it('skips blank lines without reporting them as issues', () => {
    const content = 'a@example.com x@external.tld\n\n\nb@example.com y@external.tld';
    const result = parsePostfixVirtual(content);
    expect(result.entries).toHaveLength(2);
    expect(result.issues).toEqual([]);
  });

  it('skips whole-line comments without reporting them as issues', () => {
    const content = ['# comment', 'a@example.com x@external.tld', '#no-space-comment'].join('\n');
    const result = parsePostfixVirtual(content);
    expect(result.entries).toHaveLength(1);
    expect(result.issues).toEqual([]);
  });

  it('tolerates trailing whitespace and CRLF line endings', () => {
    const content = 'a@example.com x@external.tld   \r\nb@example.com y@external.tld\t\r\n';
    const result = parsePostfixVirtual(content);
    expect(result.issues).toEqual([]);
    expect(result.entries).toHaveLength(2);
  });

  it('handles an empty file', () => {
    const result = parsePostfixVirtual('');
    expect(result.entries).toEqual([]);
    expect(result.issues).toEqual([]);
  });
});

describe('parsePostfixVirtual — unicode addresses', () => {
  it('accepts unicode (IDN/SMTPUTF8) addresses on both sides', () => {
    const result = parsePostfixVirtual('用户@例え.jp josé@example.com');
    expect(result.issues).toEqual([]);
    expect(result.entries[0]).toMatchObject({ localPart: '用户', domain: '例え.jp' });
    expect(result.entries[0]?.recipients).toEqual(['josé@example.com']);
  });
});

describe('parsePostfixVirtual — malformed lines are reported, never thrown, never silently dropped', () => {
  it('does not throw on binary garbage or arbitrary junk', () => {
    expect(() => parsePostfixVirtual('\x00\x01\x02not-a-real-line')).not.toThrow();
    expect(() => parsePostfixVirtual('@ @ @')).not.toThrow();
    expect(() => parsePostfixVirtual('a'.repeat(10_000))).not.toThrow();
  });

  it('reports a line with no recipient field as an issue, not an entry', () => {
    const result = parsePostfixVirtual('onlyonefield@example.com');
    expect(result.entries).toEqual([]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ line: 1, raw: 'onlyonefield@example.com' });
  });

  it('reports an invalid left-hand address as an issue', () => {
    const result = parsePostfixVirtual('not-an-address x@external.tld');
    expect(result.entries).toEqual([]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.reason).toContain('not-an-address');
  });

  it('reports an invalid recipient as an issue', () => {
    const result = parsePostfixVirtual('a@example.com not-an-address');
    expect(result.entries).toEqual([]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.reason).toContain('not-an-address');
  });

  it('reports a bare double-@ catch-all as an issue', () => {
    const result = parsePostfixVirtual('@@example.com x@external.tld');
    expect(result.entries).toEqual([]);
    expect(result.issues).toHaveLength(1);
  });

  it('preserves the exact 1-based line number and untouched raw text of a bad line among good ones', () => {
    const content = [
      'good@example.com x@external.tld',
      'THIS LINE IS BROKEN', // line 2 — no recipient field
      'good2@example.com y@external.tld',
    ].join('\n');
    const result = parsePostfixVirtual(content);

    expect(result.entries).toHaveLength(2);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ line: 2, raw: 'THIS LINE IS BROKEN' });
  });

  it('a bad line never removes an otherwise-valid alias from the result (no silent data loss)', () => {
    const content = ['good@example.com x@external.tld', 'bad-line-here'].join('\n');
    const result = parsePostfixVirtual(content);
    expect(result.entries.map((e) => e.address)).toEqual(['good@example.com']);
    expect(result.issues).toHaveLength(1);
  });
});
