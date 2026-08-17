/**
 * Reverse-DNS (PTR) checker for a domain's mail-sending addresses
 * (FEATURE_MATRIX.md §10's "PTR and A/AAAA"). Resolves the domain's own
 * A/AAAA records, then reverse-looks-up each address — a domain with no
 * PTR record on its sending IP is a common, real deliverability problem
 * worth surfacing, but ambiguous per-address failures must degrade to
 * `'detected'`/`'unknown'` rather than a confident `'invalid'`, same
 * missing-vs-unknown discipline as every other checker here.
 */
import type { DnsLookupPort } from './types.js';
import { classifyDnsError, describeDnsError } from './errors.js';
import type { DnsIssue, PtrCheck } from '@dwg/shared';

function issue(severity: DnsIssue['severity'], message: string): DnsIssue {
  return { severity, message };
}

type AddressLookup =
  | { readonly outcome: 'ok'; readonly addresses: readonly string[] }
  | { readonly outcome: 'missing' }
  | { readonly outcome: 'unknown'; readonly error: unknown };

async function lookupAddresses(fn: () => Promise<readonly string[]>): Promise<AddressLookup> {
  try {
    const addresses = await fn();
    return { outcome: 'ok', addresses };
  } catch (err) {
    return classifyDnsError(err) === 'missing'
      ? { outcome: 'missing' }
      : { outcome: 'unknown', error: err };
  }
}

export async function checkPtr(resolver: DnsLookupPort, domain: string): Promise<PtrCheck> {
  const [aResult, aaaaResult] = await Promise.all([
    lookupAddresses(() => resolver.resolve4(domain)),
    lookupAddresses(() => resolver.resolve6(domain)),
  ]);

  const addresses = [
    ...(aResult.outcome === 'ok' ? aResult.addresses : []),
    ...(aaaaResult.outcome === 'ok' ? aaaaResult.addresses : []),
  ];

  const forwardLookupUnknown =
    (aResult.outcome === 'unknown' && aaaaResult.outcome !== 'ok') ||
    (aaaaResult.outcome === 'unknown' && aResult.outcome !== 'ok');

  if (addresses.length === 0) {
    if (aResult.outcome === 'unknown' || aaaaResult.outcome === 'unknown') {
      const err =
        aResult.outcome === 'unknown' ? aResult.error : (aaaaResult as { error: unknown }).error;
      return {
        state: 'unknown',
        addresses: [],
        ptrByAddress: {},
        issues: [issue('error', describeDnsError(err))],
      };
    }
    return { state: 'missing', addresses: [], ptrByAddress: {}, issues: [] };
  }

  const ptrByAddress: Record<string, string[]> = {};
  const issues: DnsIssue[] = [];
  let anyPtrUnknown = forwardLookupUnknown;
  let anyPtrMissing = false;

  for (const address of addresses) {
    try {
      ptrByAddress[address] = [...(await resolver.reverse(address))];
    } catch (err) {
      if (classifyDnsError(err) === 'missing') {
        ptrByAddress[address] = [];
        anyPtrMissing = true;
        issues.push(issue('warning', `No PTR (reverse DNS) record for ${address}.`));
      } else {
        ptrByAddress[address] = [];
        anyPtrUnknown = true;
        issues.push(
          issue('warning', `Could not check reverse DNS for ${address}: ${describeDnsError(err)}`),
        );
      }
    }
  }

  if (anyPtrUnknown) {
    return { state: 'detected', addresses, ptrByAddress, issues };
  }
  if (anyPtrMissing) {
    return { state: 'invalid', addresses, ptrByAddress, issues };
  }
  return { state: 'valid', addresses, ptrByAddress, issues: [] };
}
