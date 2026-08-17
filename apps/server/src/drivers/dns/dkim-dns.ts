/**
 * DKIM checker — the DNS-side presence/shape check at
 * `<selector>._domainkey.<domain>` (FEATURE_MATRIX.md §10). This is
 * distinct from `drivers/dms/dkim-record.ts`, which parses the *source of
 * truth* zone-file the DMS driver reads after `setup config dkim`
 * generates a key — this module only ever asks the public DNS system what
 * is currently published, which is exactly what "verify" (§11's
 * generate → publish → verify flow) needs to compare against.
 */
import type { DnsLookupPort } from './types.js';
import { classifyDnsError, describeDnsError } from './errors.js';
import type { DkimDnsCheck, DnsIssue } from '@dwg/shared';

const DKIM_PREFIX_PATTERN = /(?:^|;)\s*v=DKIM1(?:;|\s|$)/i;

function joinTxtRecord(chunks: readonly string[]): string {
  return chunks.join('');
}

function issue(severity: DnsIssue['severity'], message: string): DnsIssue {
  return { severity, message };
}

/**
 * Extracts the `p=` tag's value from a DKIM TXT record; `null` if the tag
 * is absent entirely (distinct from present-but-empty, which signals
 * revocation — RFC 6376 §3.6.1). Exported for `modules/security/dkim.service.ts`,
 * which uses it to compare "what DNS currently publishes" against "what
 * the DMS driver's own zone-file record says" on just the key material,
 * not incidental formatting differences (spacing, tag order) between the
 * two sources.
 */
export function extractPublicKeyTag(record: string): string | null {
  for (const part of record.split(';')) {
    const trimmed = part.trim();
    if (trimmed.toLowerCase().startsWith('p=')) return trimmed.slice(2).trim();
  }
  return null;
}

export async function checkDkimDns(
  resolver: DnsLookupPort,
  domain: string,
  selector: string,
): Promise<DkimDnsCheck> {
  const hostname = `${selector}._domainkey.${domain}`;

  let candidates: readonly string[];
  try {
    const txts = await resolver.resolveTxt(hostname);
    // A DKIM record without an explicit "v=DKIM1" tag is still valid per
    // RFC 6376 §3.6.1 ("the version tag is OPTIONAL"), so a bare `p=...`
    // record is accepted too — matched by requiring *either* the version
    // tag or a `p=` tag to be present.
    candidates = txts
      .map(joinTxtRecord)
      .filter((record) => DKIM_PREFIX_PATTERN.test(record) || /(?:^|;)\s*p=/i.test(record));
  } catch (err) {
    const failure = classifyDnsError(err);
    return {
      state: failure === 'missing' ? 'missing' : 'unknown',
      selector,
      record: null,
      issues: failure === 'missing' ? [] : [issue('error', describeDnsError(err))],
    };
  }

  if (candidates.length === 0) {
    return { state: 'missing', selector, record: null, issues: [] };
  }

  if (candidates.length > 1) {
    return {
      state: 'invalid',
      selector,
      record: null,
      issues: [
        issue('error', `${candidates.length} DKIM records found at ${hostname} — expected one.`),
      ],
    };
  }

  const record = candidates[0] as string;
  const publicKey = extractPublicKeyTag(record);
  const issues: DnsIssue[] = [];

  if (publicKey === null) {
    issues.push(issue('error', 'DKIM record is missing the required "p=" public-key tag.'));
    return { state: 'invalid', selector, record, issues };
  }

  if (publicKey.length === 0) {
    issues.push(
      issue(
        'warning',
        'The "p=" tag is empty — per RFC 6376 this key has been explicitly revoked.',
      ),
    );
  }

  return { state: 'valid', selector, record, issues };
}
