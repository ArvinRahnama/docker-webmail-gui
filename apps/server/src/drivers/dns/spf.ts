/**
 * SPF checker — the "validation goes beyond presence" FEATURE_MATRIX.md
 * §10 requires: multiple SPF records, >10 DNS lookups (RFC 7208 §4.6.4), and
 * `~all` vs `-all` vs `?all` (`docs/research/03-mail-stack-components.md`
 * §8's "Common SPF/DMARC errors" section; RFC 7208).
 *
 * Lookup counting is genuinely recursive: RFC 7208 counts every
 * DNS-query-consuming mechanism (`a`, `mx`, `ptr`, `exists`, `include`,
 * `redirect`) against **one shared budget of 10**, including those
 * contributed by whatever an `include:`/`redirect=` target's own SPF
 * record adds — a shallow, top-level-only count would under-report a
 * record built from a few `include:`s that each pull in several more
 * mechanisms. `ip4:`/`ip6:` never consume a lookup and are not counted.
 */
import type { DnsLookupPort } from './types.js';
import { classifyDnsError, describeDnsError } from './errors.js';
import type { DnsIssue, SpfAllQualifier, SpfCheck } from '@dwg/shared';

const SPF_PREFIX_PATTERN = /^v=spf1(?:\s|$)/i;
const ALL_TOKEN_PATTERN = /^([+\-~?]?)all$/i;
const MAX_SPF_RECURSION_DEPTH = 10;
const SPF_RFC_LOOKUP_LIMIT = 10;

function joinTxtRecord(chunks: readonly string[]): string {
  return chunks.join('');
}

async function fetchSpfRecords(resolver: DnsLookupPort, domain: string): Promise<string[] | null> {
  const txts = await resolver.resolveTxt(domain);
  return txts.map(joinTxtRecord).filter((record) => SPF_PREFIX_PATTERN.test(record));
}

/**
 * Recursively sums DNS-query-consuming mechanisms across an `include:`/
 * `redirect=` chain. Returns `null` when a nested lookup could not be
 * completed (network/timeout — `classifyDnsError` would call it
 * `'unknown'`), so the caller can report "could not be fully determined"
 * rather than a confidently wrong number. `visited` prevents infinite
 * recursion on a (malicious or misconfigured) circular reference; `depth`
 * is an independent hard cap for the same reason, matching this project's
 * general "bound every resolver-driven loop" rule (SECURITY.md §3.4).
 */
async function countSpfLookups(
  resolver: DnsLookupPort,
  record: string,
  visited: Set<string>,
  depth: number,
): Promise<number | null> {
  if (depth > MAX_SPF_RECURSION_DEPTH) return null;

  const tokens = record.trim().split(/\s+/).slice(1);
  let count = 0;

  for (const token of tokens) {
    const bare = token.replace(/^[+\-~?]/, '');
    const lower = bare.toLowerCase();

    if (lower === 'all' || lower.length === 0) continue;
    if (lower.startsWith('ip4:') || lower.startsWith('ip6:')) continue;

    if (lower === 'a' || lower.startsWith('a:') || lower.startsWith('a/')) {
      count += 1;
      continue;
    }
    if (lower === 'mx' || lower.startsWith('mx:') || lower.startsWith('mx/')) {
      count += 1;
      continue;
    }
    if (lower === 'ptr' || lower.startsWith('ptr:')) {
      count += 1;
      continue;
    }
    if (lower.startsWith('exists:')) {
      count += 1;
      continue;
    }

    const includeTarget = lower.startsWith('include:') ? bare.slice('include:'.length) : null;
    const redirectTarget = lower.startsWith('redirect=') ? bare.slice('redirect='.length) : null;
    const target = includeTarget ?? redirectTarget;
    if (target === null) continue; // unrecognised mechanism/modifier — no DNS query implied.

    count += 1;
    const normalizedTarget = target.toLowerCase();
    if (normalizedTarget.length === 0 || visited.has(normalizedTarget)) continue;
    visited.add(normalizedTarget);

    let nestedRecords: readonly string[] | null;
    try {
      nestedRecords = await fetchSpfRecords(resolver, normalizedTarget);
    } catch {
      return null;
    }
    if (nestedRecords === null || nestedRecords.length !== 1) continue;

    const nestedCount = await countSpfLookups(
      resolver,
      nestedRecords[0] as string,
      visited,
      depth + 1,
    );
    if (nestedCount === null) return null;
    count += nestedCount;
  }

  return count;
}

function extractAllQualifier(record: string): SpfAllQualifier | null {
  const tokens = record.trim().split(/\s+/);
  let found: SpfAllQualifier | null = null;
  for (const token of tokens) {
    const match = ALL_TOKEN_PATTERN.exec(token);
    if (match) {
      const qualifier = (match[1] ?? '+') as '' | '+' | '-' | '~' | '?';
      found = qualifier === '' ? '+all' : (`${qualifier}all` as SpfAllQualifier);
    }
  }
  return found;
}

function issue(severity: DnsIssue['severity'], message: string): DnsIssue {
  return { severity, message };
}

function allQualifierIssue(qualifier: SpfAllQualifier | null): DnsIssue {
  switch (qualifier) {
    case '-all':
      return issue('info', 'Hardfail (-all) — SPF is enforced for this domain.');
    case '~all':
      return issue('info', 'Softfail (~all) — SPF is in monitoring mode, not fully enforced.');
    case '?all':
      return issue('warning', 'Neutral (?all) provides no meaningful protection.');
    case '+all':
      return issue(
        'warning',
        'Pass-all (+all) permits any host to send as this domain — SPF provides no protection.',
      );
    case 'none':
    case null:
      return issue(
        'warning',
        'No "all" mechanism found — the record has no default/catch-all action.',
      );
  }
}

export async function checkSpf(resolver: DnsLookupPort, domain: string): Promise<SpfCheck> {
  let allRecords: string[];
  try {
    allRecords = (await fetchSpfRecords(resolver, domain)) ?? [];
  } catch (err) {
    const failure = classifyDnsError(err);
    if (failure === 'missing') {
      return {
        state: 'missing',
        record: null,
        allRecords: [],
        lookupCount: null,
        allQualifier: null,
        issues: [],
      };
    }
    return {
      state: 'unknown',
      record: null,
      allRecords: [],
      lookupCount: null,
      allQualifier: null,
      issues: [issue('error', describeDnsError(err))],
    };
  }

  if (allRecords.length === 0) {
    return {
      state: 'missing',
      record: null,
      allRecords: [],
      lookupCount: null,
      allQualifier: null,
      issues: [],
    };
  }

  if (allRecords.length > 1) {
    return {
      state: 'invalid',
      record: null,
      allRecords,
      lookupCount: null,
      allQualifier: null,
      issues: [
        issue(
          'error',
          `${allRecords.length} SPF records found — RFC 7208 permits exactly one "v=spf1" record per domain.`,
        ),
      ],
    };
  }

  const record = allRecords[0] as string;
  const allQualifier = extractAllQualifier(record);
  const issues: DnsIssue[] = [allQualifierIssue(allQualifier)];

  let lookupCount: number | null;
  try {
    lookupCount = await countSpfLookups(resolver, record, new Set([domain.toLowerCase()]), 0);
  } catch {
    lookupCount = null;
  }

  if (lookupCount === null) {
    issues.push(
      issue(
        'warning',
        'The DNS lookup count could not be fully determined (a nested include/redirect lookup failed).',
      ),
    );
  } else if (lookupCount > SPF_RFC_LOOKUP_LIMIT) {
    issues.push(
      issue(
        'error',
        `This record requires ${lookupCount} DNS lookups, exceeding the RFC 7208 limit of ${SPF_RFC_LOOKUP_LIMIT} — receivers may treat it as a permanent error (permerror).`,
      ),
    );
  }

  const hasError = issues.some((i) => i.severity === 'error');
  const state = hasError ? 'invalid' : lookupCount === null ? 'detected' : 'valid';

  return { state, record, allRecords, lookupCount, allQualifier, issues };
}
