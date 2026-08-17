/**
 * DMARC checker — presence plus the validation beyond presence the brief
 * calls for: `p=none` (monitoring only, not enforced) and a missing
 * `rua=` aggregate-report address
 * (`docs/research/03-mail-stack-components.md` §8; RFC 7489).
 */
import type { DnsLookupPort } from './types.js';
import { classifyDnsError, describeDnsError } from './errors.js';
import type { DmarcCheck, DmarcPolicy, DnsIssue } from '@dwg/shared';

const DMARC_PREFIX_PATTERN = /^v=DMARC1(?:;|\s|$)/i;
const DMARC_POLICY_VALUES: readonly DmarcPolicy[] = ['none', 'quarantine', 'reject'];

function joinTxtRecord(chunks: readonly string[]): string {
  return chunks.join('');
}

function issue(severity: DnsIssue['severity'], message: string): DnsIssue {
  return { severity, message };
}

/** Parses `tag=value; tag2=value2` DMARC record syntax (RFC 7489 §6.4) into a plain map, lowercased keys, trimmed values. Never throws on malformed input — unrecognised tags/garbage are simply absent from the result. */
function parseTags(record: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const part of record.split(';')) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim().toLowerCase();
    const value = trimmed.slice(eq + 1).trim();
    if (key.length > 0) tags.set(key, value);
  }
  return tags;
}

function parsePolicy(value: string | undefined): DmarcPolicy | null {
  if (value === undefined) return null;
  const lower = value.toLowerCase();
  return (DMARC_POLICY_VALUES as readonly string[]).includes(lower) ? (lower as DmarcPolicy) : null;
}

export async function checkDmarc(resolver: DnsLookupPort, domain: string): Promise<DmarcCheck> {
  const hostname = `_dmarc.${domain}`;
  let candidates: readonly string[];

  try {
    const txts = await resolver.resolveTxt(hostname);
    candidates = txts.map(joinTxtRecord).filter((record) => DMARC_PREFIX_PATTERN.test(record));
  } catch (err) {
    const failure = classifyDnsError(err);
    const empty: DmarcCheck = {
      state: failure === 'missing' ? 'missing' : 'unknown',
      record: null,
      policy: null,
      subdomainPolicy: null,
      hasRua: false,
      pct: null,
      issues: failure === 'missing' ? [] : [issue('error', describeDnsError(err))],
    };
    return empty;
  }

  if (candidates.length === 0) {
    return {
      state: 'missing',
      record: null,
      policy: null,
      subdomainPolicy: null,
      hasRua: false,
      pct: null,
      issues: [],
    };
  }

  if (candidates.length > 1) {
    return {
      state: 'invalid',
      record: null,
      policy: null,
      subdomainPolicy: null,
      hasRua: false,
      pct: null,
      issues: [
        issue(
          'error',
          `${candidates.length} DMARC records found at ${hostname} — RFC 7489 permits exactly one.`,
        ),
      ],
    };
  }

  const record = candidates[0] as string;
  const tags = parseTags(record);
  const policy = parsePolicy(tags.get('p'));
  const subdomainPolicy = parsePolicy(tags.get('sp')) ?? policy;
  const rua = tags.get('rua');
  const hasRua = rua !== undefined && rua.trim().length > 0;
  const pctRaw = tags.get('pct');
  const pct = pctRaw !== undefined && /^\d{1,3}$/.test(pctRaw) ? Number(pctRaw) : null;

  const issues: DnsIssue[] = [];

  if (policy === null) {
    issues.push(issue('error', 'DMARC record is missing the required "p=" policy tag.'));
  } else if (policy === 'none') {
    issues.push(
      issue(
        'warning',
        'DMARC policy is "p=none" — monitoring only, not enforced against spoofed mail.',
      ),
    );
  } else {
    issues.push(issue('info', `DMARC policy is "p=${policy}" — enforced.`));
  }

  if (!hasRua) {
    issues.push(
      issue(
        'warning',
        'No "rua=" aggregate-report address configured — the domain owner gets no visibility into SPF/DKIM/DMARC results at scale.',
      ),
    );
  }

  if (pctRaw !== undefined && (pct === null || pct < 0 || pct > 100)) {
    issues.push(issue('error', `"pct=${pctRaw}" is not a valid percentage (0-100).`));
  }

  const hasError = issues.some((i) => i.severity === 'error');

  return {
    state: hasError ? 'invalid' : 'valid',
    record,
    policy,
    subdomainPolicy,
    hasRua,
    pct,
    issues,
  };
}
