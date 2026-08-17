/**
 * Deterministic, in-memory {@link DnsLookupPort} — the development default
 * (`create-dns-resolver.ts`) and the test double every checker's own test
 * file builds against, mirroring `drivers/dms/fake-dms-driver.ts`'s role
 * for the DMS driver. Touches no network. Records are seeded by hostname;
 * an unseeded hostname throws `ENOTFOUND` (an authoritative negative
 * answer — `errors.ts` classifies that as `'missing'`, matching what a
 * real resolver would report for a domain with no such record).
 */
import type { DnsLookupPort, DnsMxRecord } from './types.js';

function errnoError(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

export interface FakeDnsRecordSet {
  readonly mx?: readonly DnsMxRecord[];
  /** One entry per TXT record; each entry is that record's raw chunks (unjoined), matching `resolveTxt`'s real shape. */
  readonly txt?: readonly (readonly string[])[];
  readonly a?: readonly string[];
  readonly aaaa?: readonly string[];
}

export class FakeDnsLookupPort implements DnsLookupPort {
  private readonly records = new Map<string, FakeDnsRecordSet>();
  private readonly ptrRecords = new Map<string, readonly string[]>();
  private readonly failures = new Map<string, string>();

  /** Seeds (or replaces) the full record set for one hostname, lowercased for lookup. */
  setRecords(hostname: string, records: FakeDnsRecordSet): this {
    this.records.set(hostname.toLowerCase(), records);
    return this;
  }

  /** Convenience for the common single-TXT-record case, e.g. an SPF or DMARC record. */
  setTxt(hostname: string, ...records: readonly string[]): this {
    const existing = this.records.get(hostname.toLowerCase()) ?? {};
    this.records.set(hostname.toLowerCase(), {
      ...existing,
      txt: records.map((record) => [record]),
    });
    return this;
  }

  setPtr(ip: string, ...hostnames: readonly string[]): this {
    this.ptrRecords.set(ip, hostnames);
    return this;
  }

  /**
   * Makes every lookup against `hostnameOrIp` throw an error with `code`
   * (e.g. `'ETIMEOUT'`, `'ESERVFAIL'`) instead of returning/missing —
   * simulates a transient resolver failure so tests can assert the
   * `'unknown'`, never-`'invalid'` outcome (FEATURE_MATRIX.md §10).
   */
  setFailure(hostnameOrIp: string, code: string): this {
    this.failures.set(hostnameOrIp.toLowerCase(), code);
    return this;
  }

  private checkFailure(key: string): void {
    const code = this.failures.get(key.toLowerCase());
    if (code !== undefined) throw errnoError(code, `simulated ${code} for ${key}`);
  }

  async resolveMx(hostname: string): Promise<readonly DnsMxRecord[]> {
    this.checkFailure(hostname);
    const entry = this.records.get(hostname.toLowerCase())?.mx;
    if (entry === undefined || entry.length === 0) {
      throw errnoError('ENODATA', `no MX record for ${hostname}`);
    }
    return entry;
  }

  async resolveTxt(hostname: string): Promise<readonly (readonly string[])[]> {
    this.checkFailure(hostname);
    const entry = this.records.get(hostname.toLowerCase())?.txt;
    if (entry === undefined || entry.length === 0) {
      throw errnoError('ENODATA', `no TXT record for ${hostname}`);
    }
    return entry;
  }

  async resolve4(hostname: string): Promise<readonly string[]> {
    this.checkFailure(hostname);
    const entry = this.records.get(hostname.toLowerCase())?.a;
    if (entry === undefined || entry.length === 0) {
      throw errnoError('ENODATA', `no A record for ${hostname}`);
    }
    return entry;
  }

  async resolve6(hostname: string): Promise<readonly string[]> {
    this.checkFailure(hostname);
    const entry = this.records.get(hostname.toLowerCase())?.aaaa;
    if (entry === undefined || entry.length === 0) {
      throw errnoError('ENODATA', `no AAAA record for ${hostname}`);
    }
    return entry;
  }

  async reverse(ip: string): Promise<readonly string[]> {
    this.checkFailure(ip);
    const entry = this.ptrRecords.get(ip);
    if (entry === undefined || entry.length === 0) {
      throw errnoError('ENOTFOUND', `no PTR record for ${ip}`);
    }
    return entry;
  }
}
