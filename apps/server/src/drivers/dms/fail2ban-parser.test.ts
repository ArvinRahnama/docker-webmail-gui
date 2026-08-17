import { describe, expect, it } from 'vitest';
import { parseFail2banList } from './fail2ban-parser.js';

describe('parseFail2banList', () => {
  it('extracts IPv4 addresses from a simple list', () => {
    const result = parseFail2banList('203.0.113.5\n198.51.100.20\n');
    expect(result.bannedIps).toEqual(['198.51.100.20', '203.0.113.5']);
  });

  it('extracts addresses embedded in a jail-labelled table format', () => {
    const result = parseFail2banList(
      'Jail: dovecot\nBanned: 203.0.113.5 198.51.100.20\nJail: postfix\nBanned: 203.0.113.9\n',
    );
    expect(result.bannedIps).toEqual(['198.51.100.20', '203.0.113.5', '203.0.113.9']);
  });

  it('deduplicates repeated addresses', () => {
    const result = parseFail2banList('203.0.113.5\n203.0.113.5\n');
    expect(result.bannedIps).toEqual(['203.0.113.5']);
  });

  it('returns an empty list, never throwing, when nothing is banned', () => {
    expect(() => parseFail2banList('No IPs are banned.')).not.toThrow();
    expect(parseFail2banList('No IPs are banned.').bannedIps).toEqual([]);
  });

  it('never throws on empty input', () => {
    expect(parseFail2banList('').bannedIps).toEqual([]);
  });

  it('extracts a real IPv6 address', () => {
    const result = parseFail2banList('Banned: 2001:db8:85a3:8d3:1319:8a2e:370:7348');
    expect(result.bannedIps).toEqual(['2001:db8:85a3:8d3:1319:8a2e:370:7348']);
  });

  it('does not misread an HH:MM:SS timestamp elsewhere in the output as an IPv6 address', () => {
    const result = parseFail2banList('Report generated at 14:32:07 on 2026-08-17. No bans.');
    expect(result.bannedIps).toEqual([]);
  });

  it('always returns the raw output verbatim regardless of extraction success', () => {
    const raw = 'some format setup fail2ban might use';
    expect(parseFail2banList(raw).raw).toBe(raw);
  });
});
