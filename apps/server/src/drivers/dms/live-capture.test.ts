/**
 * The nine "Deferred to runtime verification" rows in FEATURE_MATRIX.md,
 * checked against output captured from a live docker-mailserver
 * (`fixtures/live-capture.ts` carries the full provenance).
 *
 * Until M17 this project had never had a Docker daemon, so every one of
 * those parsers was written from documentation and its fallback had never
 * been observed firing. This file is what keeps the answers from drifting
 * back into assumption: each case names the deferred item it settles.
 */
import { describe, expect, it } from 'vitest';
import { parseDoveadmQuotaGet } from './quota-usage.js';
import { parseFail2banList } from './fail2ban-parser.js';
import { parsePostfixAccess } from './parsers/postfix-access.js';
import { parseDkimZoneFile, parseDkimZoneFileValue } from './dkim-record.js';
import { parseClamdVersion } from './clamav-parser.js';
import {
  LIVE_CLAMAV_VERSION,
  LIVE_DKIM_RSPAMD_PUBLIC_DNS,
  LIVE_DOVEADM_QUOTA_GET_JSON,
  LIVE_FAIL2BAN_STATUS,
  LIVE_POSTFIX_SEND_ACCESS_CF,
  LIVE_RSPAMD_STAT_JSON,
} from './fixtures/live-capture.js';

describe('deferred item 8 — doveadm quota get key casing and units', () => {
  it('reads a 500M quota as 500 MiB, confirming the KiB convention', () => {
    const result = parseDoveadmQuotaGet(LIVE_DOVEADM_QUOTA_GET_JSON);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `limit` came back as the string "512000". 500 MiB in KiB.
    expect(result.usage.storageBytesLimit).toBe(500 * 1024 * 1024);
    expect(result.usage.storageBytesUsed).toBe(0);
    // MESSAGE limit was "-" — unlimited, not zero, and not a parse failure.
    expect(result.usage.messageCountLimit).toBeNull();
  });
});

describe('deferred item 5 — setup fail2ban status output shape', () => {
  it('parses the real multi-jail tree without inventing bans', () => {
    const result = parseFail2banList(LIVE_FAIL2BAN_STATUS);
    expect(result.bannedIps).toEqual([]);
    // The raw text is always preserved, which is the documented fallback
    // for exactly this parser.
    expect(result.raw).toContain('Status for the jail:');
  });
});

describe('deferred item 9 — postfix access file line format', () => {
  it('parses the address/action pair setup email restrict actually wrote', () => {
    const result = parsePostfixAccess(LIVE_POSTFIX_SEND_ACCESS_CF);
    expect(result.issues).toEqual([]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.email).toBe('first@example.test');
    expect(result.entries[0]?.action).toBe('REJECT');
  });
});

describe('deferred item 2 — DKIM key layout under ENABLE_RSPAMD=1', () => {
  it('parses the bare, unquoted record Rspamd writes', () => {
    // This is the case that was broken. The file is not RFC 1035 quoted
    // zone-file syntax, so the original parser found no quoted strings and
    // returned null — reporting a real, valid key as unparseable.
    const record = parseDkimZoneFile(LIVE_DKIM_RSPAMD_PUBLIC_DNS, 'example.test', 'mail');
    expect(record).not.toBeNull();
    expect(record?.name).toBe('mail._domainkey.example.test');
    expect(record?.value.startsWith('v=DKIM1;')).toBe(true);
    expect(record?.value).toContain('p=');
  });

  it("still parses OpenDKIM's quoted zone-file form", () => {
    const zone = 'mail._domainkey\tIN\tTXT\t( "v=DKIM1; k=rsa; "\n\t  "p=ABC" )';
    expect(parseDkimZoneFileValue(zone)).toBe('v=DKIM1; k=rsa; p=ABC');
  });

  it('still refuses a file that is not a DKIM record at all', () => {
    // The bare-value branch is deliberately narrow: without this, any
    // unquoted file would be echoed back to an admin as a DNS value.
    expect(parseDkimZoneFileValue('hello world')).toBeNull();
    expect(parseDkimZoneFileValue('')).toBeNull();
  });
});

describe('deferred item 6 — ClamAV VERSION string format', () => {
  it('splits the real engine/signature/date triple', () => {
    const parsed = parseClamdVersion(LIVE_CLAMAV_VERSION);
    expect(parsed.engineVersion).toBe('ClamAV 1.0.7');
    expect(parsed.signatureVersion).toBe('27728');
    expect(parsed.signatureDate).toBe('Sun Aug 10 08:32:45 2025');
  });
});

describe('deferred item 3 — Rspamd /stat field names', () => {
  it('carries every field the dashboard binds, including space-containing action keys', () => {
    const stat = JSON.parse(LIVE_RSPAMD_STAT_JSON) as Record<string, unknown>;
    for (const field of ['version', 'scanned', 'learned', 'spam_count', 'ham_count', 'actions']) {
      expect(stat, `missing /stat field: ${field}`).toHaveProperty(field);
    }
    const actions = stat['actions'] as Record<string, unknown>;
    // Worth pinning: these keys contain spaces, which is the kind of thing
    // a hand-written binding gets wrong.
    for (const action of ['reject', 'soft reject', 'rewrite subject', 'add header', 'no action']) {
      expect(actions, `missing action key: ${action}`).toHaveProperty(action);
    }
  });
});
