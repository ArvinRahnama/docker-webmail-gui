/**
 * Orchestrates every per-domain DNS check into one report
 * (UX_ARCHITECTURE.md §6.2 "Email Authentication"; FEATURE_MATRIX.md
 * §10). Each record type's own module (`spf.ts`, `dmarc.ts`,
 * `dkim-dns.ts`, `ptr.ts`) already returns exactly one of the five
 * `DnsRecordState`s with no cross-record inference — this module runs
 * them concurrently and assembles the result, deliberately doing no
 * additional interpretation itself, so a failure in one record's check
 * can never influence another's (a degraded/partial page, never a blank
 * one — UX_ARCHITECTURE.md §9).
 */
import type { DnsLookupPort } from './types.js';
import { classifyDnsError, describeDnsError } from './errors.js';
import { checkSpf } from './spf.js';
import { checkDmarc } from './dmarc.js';
import { checkDkimDns } from './dkim-dns.js';
import { checkPtr } from './ptr.js';
import type { DnsIssue, EmailAuthReport, MxCheck } from '@dwg/shared';

function issue(severity: DnsIssue['severity'], message: string): DnsIssue {
  return { severity, message };
}

async function checkMx(resolver: DnsLookupPort, domain: string): Promise<MxCheck> {
  try {
    const records = await resolver.resolveMx(domain);
    if (records.length === 0) {
      return { state: 'missing', records: [], issues: [] };
    }
    const sorted = [...records].sort((a, b) => a.priority - b.priority);
    return { state: 'valid', records: sorted, issues: [] };
  } catch (err) {
    const failure = classifyDnsError(err);
    return {
      state: failure === 'missing' ? 'missing' : 'unknown',
      records: [],
      issues: failure === 'missing' ? [] : [issue('error', describeDnsError(err))],
    };
  }
}

export const DEFAULT_DKIM_SELECTOR = 'mail';

export interface CheckEmailAuthOptions {
  /** Defaults to DMS's own default DKIM selector (`mail` — `docs/research/01-docker-mailserver.md` §7). */
  readonly selector?: string;
}

export async function checkEmailAuth(
  resolver: DnsLookupPort,
  domain: string,
  options: CheckEmailAuthOptions = {},
): Promise<EmailAuthReport> {
  const selector = options.selector ?? DEFAULT_DKIM_SELECTOR;

  const [mx, spf, dkim, dmarc, ptr] = await Promise.all([
    checkMx(resolver, domain),
    checkSpf(resolver, domain),
    checkDkimDns(resolver, domain, selector),
    checkDmarc(resolver, domain),
    checkPtr(resolver, domain),
  ]);

  return {
    domain,
    checkedAt: new Date().toISOString(),
    mx,
    spf,
    dkim,
    dmarc,
    ptr,
  };
}
