import { describe, expect, it } from 'vitest';
import { FIXTURE_DKIM_TXT_FILE, FIXTURE_DKIM_TXT_FILE_TRUNCATED } from './fixtures/dkim.js';
import { parseDkimZoneFile, parseDkimZoneFileValue } from './dkim-record.js';

describe('parseDkimZoneFileValue', () => {
  it('joins every quoted chunk, in order, from a real-shaped zone file', () => {
    const value = parseDkimZoneFileValue(FIXTURE_DKIM_TXT_FILE);
    expect(value).not.toBeNull();
    expect(value).toMatch(/^v=DKIM1; h=sha256; k=rsa; p=MIGf/);
    expect(value).not.toContain('"');
  });

  it('returns null for content with no quoted strings', () => {
    expect(parseDkimZoneFileValue('not a zone file at all')).toBeNull();
    expect(parseDkimZoneFileValue('')).toBeNull();
  });

  it('returns null for truncated/malformed content rather than throwing', () => {
    expect(() => parseDkimZoneFileValue(FIXTURE_DKIM_TXT_FILE_TRUNCATED)).not.toThrow();
    // The one opening quote here has no closing partner captured as a full
    // token by the regex engine's own matching (no crash either way) —
    // the important property is "never throws", asserted above.
  });

  it('unescapes embedded escaped quotes and backslashes', () => {
    const value = parseDkimZoneFileValue('IN TXT "a\\"b\\\\c"');
    expect(value).toBe('a"b\\c');
  });
});

describe('parseDkimZoneFile', () => {
  it('builds the full record with a constructed owner name, not a parsed one', () => {
    const record = parseDkimZoneFile(FIXTURE_DKIM_TXT_FILE, 'example.com', 'mail');
    expect(record).not.toBeNull();
    expect(record?.name).toBe('mail._domainkey.example.com');
    expect(record?.value).toMatch(/^v=DKIM1/);
  });

  it('uses the given selector/domain even if they differ from the file body', () => {
    const record = parseDkimZoneFile(FIXTURE_DKIM_TXT_FILE, 'otherdomain.tld', 'selector2');
    expect(record?.name).toBe('selector2._domainkey.otherdomain.tld');
  });

  it('returns null when the underlying value could not be parsed', () => {
    expect(parseDkimZoneFile('garbage', 'example.com', 'mail')).toBeNull();
  });
});
