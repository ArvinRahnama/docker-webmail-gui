import { describe, expect, it } from 'vitest';
import { parseDoveadmQuotaGet } from './quota-usage.js';

describe('parseDoveadmQuotaGet — valid input', () => {
  it('parses a STORAGE + MESSAGE pair with lowercase keys', () => {
    const json = JSON.stringify([
      { quota: 'User quota', type: 'STORAGE', value: 12345, limit: 1048576, '%': 1 },
      { quota: 'User quota', type: 'MESSAGE', value: 42, limit: 0, '%': 0 },
    ]);
    const result = parseDoveadmQuotaGet(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usage.storageBytesUsed).toBe(12345 * 1024);
    expect(result.usage.storageBytesLimit).toBe(1048576 * 1024);
    expect(result.usage.messageCountUsed).toBe(42);
    // limit of 0 means unlimited, by Dovecot's own convention.
    expect(result.usage.messageCountLimit).toBeNull();
  });

  it('parses capitalised keys the same way (doveadm table-derived casing)', () => {
    const json = JSON.stringify([{ Type: 'STORAGE', Value: '100', Limit: '2000' }]);
    const result = parseDoveadmQuotaGet(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usage.storageBytesUsed).toBe(100 * 1024);
    expect(result.usage.storageBytesLimit).toBe(2000 * 1024);
  });

  it('reports an unlimited quota (no limit row) as a null limit, not zero', () => {
    const json = JSON.stringify([{ type: 'STORAGE', value: 500, limit: 0 }]);
    const result = parseDoveadmQuotaGet(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usage.storageBytesLimit).toBeNull();
  });

  it('is order-independent for the STORAGE/MESSAGE rows', () => {
    const json = JSON.stringify([
      { type: 'MESSAGE', value: 1, limit: 10 },
      { type: 'STORAGE', value: 2, limit: 20 },
    ]);
    const result = parseDoveadmQuotaGet(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usage.storageBytesUsed).toBe(2 * 1024);
    expect(result.usage.messageCountUsed).toBe(1);
  });
});

describe('parseDoveadmQuotaGet — defensive fallback to Unknown, never a fabricated number', () => {
  it('never throws on malformed input', () => {
    expect(() => parseDoveadmQuotaGet('not json at all')).not.toThrow();
    expect(() => parseDoveadmQuotaGet('')).not.toThrow();
    expect(() => parseDoveadmQuotaGet('{}')).not.toThrow();
    expect(() => parseDoveadmQuotaGet('null')).not.toThrow();
    expect(() => parseDoveadmQuotaGet('[1, 2, 3]')).not.toThrow();
  });

  it('reports ok:false for invalid JSON', () => {
    const result = parseDoveadmQuotaGet('{not valid json');
    expect(result.ok).toBe(false);
  });

  it('reports ok:false when the top level is not an array', () => {
    const result = parseDoveadmQuotaGet(JSON.stringify({ type: 'STORAGE', value: 1, limit: 2 }));
    expect(result.ok).toBe(false);
  });

  it('reports ok:false when no STORAGE row is present', () => {
    const result = parseDoveadmQuotaGet(JSON.stringify([{ type: 'MESSAGE', value: 1, limit: 2 }]));
    expect(result.ok).toBe(false);
  });

  it('reports ok:false for an empty array', () => {
    const result = parseDoveadmQuotaGet('[]');
    expect(result.ok).toBe(false);
  });

  it('ignores rows that are not objects rather than throwing', () => {
    const json = JSON.stringify([null, 'garbage', 42, { type: 'STORAGE', value: 1, limit: 2 }]);
    const result = parseDoveadmQuotaGet(json);
    expect(result.ok).toBe(true);
  });
});
