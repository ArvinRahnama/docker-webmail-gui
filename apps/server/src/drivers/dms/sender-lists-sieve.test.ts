import { describe, expect, it } from 'vitest';
import type { SenderListEntry } from '@dwg/shared';
import { validateSieveScriptContent } from './sieve-validator.js';
import { generateSenderListsSieve, parseSenderListsSieve } from './sender-lists-sieve.js';

const AT = '2026-11-12T05:23:35.151Z';
const ENTRIES: SenderListEntry[] = [
  { list: 'allow', kind: 'address', value: 'news@gmail.com', source: 'report', addedAt: AT },
  { list: 'block', kind: 'domain', value: 'yahoo.com', source: 'admin', addedAt: AT },
  { list: 'allow', kind: 'ip', value: '172.20.0.1', source: 'admin', addedAt: AT },
  { list: 'block', kind: 'ip', value: '2001:db8::1', source: 'report', addedAt: AT },
];

describe('generateSenderListsSieve', () => {
  const script = generateSenderListsSieve('alice@example.test', ENTRIES);

  it('round-trips through its own parser', () => {
    expect(parseSenderListsSieve(script)).toEqual(ENTRIES);
  });

  it('passes the same content validation as every hand-written script', () => {
    expect(validateSieveScriptContent(script).ok).toBe(true);
  });

  it('only sets the shared verdict variable — it files nothing itself', () => {
    expect(script).toContain('global "dwg_sender_verdict";');
    expect(script).not.toMatch(/\b(fileinto|redirect|discard|reject|keep|vacation)\b/);
  });

  it('matches exact addresses, exact and parent domains, and client IPs (both IPv6 forms)', () => {
    expect(script).toContain('address :all :is "from" ["news@gmail.com"]');
    expect(script).toContain('address :domain :is "from" ["yahoo.com"]');
    expect(script).toContain('address :domain :matches "from" ["*.yahoo.com"]');
    expect(script).toContain('string :is "${dwg_ip}" ["172.20.0.1"]');
    expect(script).toContain('string :is "${dwg_ip}" ["2001:db8::1", "ipv6:2001:db8::1"]');
  });

  it('never honours an allow for a message that fails DMARC with a reject/quarantine policy', () => {
    expect(script).toContain(
      'if header :contains "X-Spamd-Result" ["DMARC_POLICY_REJECT", "DMARC_POLICY_QUARANTINE"] { set "dwg_spoofed" "yes"; }',
    );
    const allowRule = script.slice(script.indexOf('address :all :is "from" ["news@gmail.com"]'));
    expect(allowRule).toMatch(
      /^[^]*?if string :is "\$\{dwg_spoofed\}" "" \{\s*set "dwg_sender_verdict" "allow";/,
    );
  });

  it('puts block before allow where wildcard rules could overlap', () => {
    const both = generateSenderListsSieve('a@x.test', [
      { list: 'allow', kind: 'domain', value: 'example.org', source: 'admin', addedAt: AT },
      { list: 'block', kind: 'domain', value: 'sub.example.org', source: 'admin', addedAt: AT },
    ]);
    const blockAt = both.indexOf('"*.sub.example.org"');
    const allowAt = both.indexOf('"*.example.org"');
    expect(blockAt).toBeGreaterThan(-1);
    expect(blockAt).toBeLessThan(allowAt);
  });

  it('writes a valid script with no rules for an empty list', () => {
    const empty = generateSenderListsSieve('a@x.test', []);
    expect(parseSenderListsSieve(empty)).toEqual([]);
    expect(empty).not.toContain('dwg_sender_verdict" "');
  });
});

describe('parseSenderListsSieve', () => {
  it('returns null for a script the panel did not write', () => {
    expect(parseSenderListsSieve('require ["fileinto"];\nfileinto "Spam";\n')).toBeNull();
  });

  it('drops tampered or invalid entry lines rather than carrying them forward', () => {
    const tampered = [
      '# dwg-sender-lists: v1',
      '# entry: allow domain good.example admin 2026-11-12T05:23:35.151Z',
      '# entry: allow domain bad"];fileinto"x admin 2026-11-12T05:23:35.151Z',
      '# entry: allow address not-an-address admin 2026-11-12T05:23:35.151Z',
      '# entry: allow domain good.example report 2026-11-12T05:23:35.151Z',
    ].join('\n');
    expect(parseSenderListsSieve(tampered)).toEqual([
      { list: 'allow', kind: 'domain', value: 'good.example', source: 'admin', addedAt: AT },
    ]);
  });
});
