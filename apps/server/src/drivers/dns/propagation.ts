/**
 * DNS "propagation" checking — offered honestly (FEATURE_MATRIX.md §10):
 * we query a **fixed list of public resolvers** individually and report
 * per-resolver answers, never a claim of global propagation, which is
 * not observable from a single vantage point. SECURITY.md §3.4 requires
 * this list be fixed, not admin-suppliable — a caller-chosen resolver
 * address would be a pathway to probe internal network hosts on port 53.
 */
import type { DnsLookupPort } from './types.js';
import { classifyDnsError, describeDnsError } from './errors.js';
import { DEFAULT_DKIM_SELECTOR } from './email-auth.js';
import type { DnsRecordState, PropagationRecordType, PropagationReport } from '@dwg/shared';

export interface PublicResolver {
  readonly name: string;
  readonly address: string;
}

/**
 * Well-known, independently-operated public resolvers — fixed at build
 * time, never influenced by request input. Three is enough to show
 * disagreement (a single divergent answer is far more informative than a
 * larger list nobody reads row-by-row).
 */
export const PUBLIC_RESOLVERS: readonly PublicResolver[] = [
  { name: 'Cloudflare', address: '1.1.1.1' },
  { name: 'Google', address: '8.8.8.8' },
  { name: 'Quad9', address: '9.9.9.9' },
];

export const PROPAGATION_CAVEAT =
  "This shows whether each public resolver currently agrees, not global propagation, which cannot be observed from one vantage point — resolvers cache answers independently until each record's TTL expires.";

/** Builds a fresh {@link DnsLookupPort} pointed at exactly one resolver address — `real-resolver.ts` and `fake-resolver.ts` both provide a compatible factory shape. */
export type DnsLookupPortFactory = (resolverAddress: string) => DnsLookupPort;

function joinTxtRecord(chunks: readonly string[]): string {
  return chunks.join('');
}

const SPF_PREFIX_PATTERN = /^v=spf1(?:\s|$)/i;
const DMARC_PREFIX_PATTERN = /^v=DMARC1(?:;|\s|$)/i;

interface PropagationOutcome {
  readonly state: DnsRecordState;
  readonly values: string[];
  readonly error: string | null;
}

async function resolveOneRecord(
  resolver: DnsLookupPort,
  domain: string,
  recordType: PropagationRecordType,
  selector: string,
): Promise<PropagationOutcome> {
  try {
    switch (recordType) {
      case 'MX': {
        const records = await resolver.resolveMx(domain);
        return records.length === 0
          ? { state: 'missing', values: [], error: null }
          : {
              state: 'detected',
              values: records.map((r) => `${r.priority} ${r.exchange}`),
              error: null,
            };
      }
      case 'A': {
        const addresses = await resolver.resolve4(domain);
        return addresses.length === 0
          ? { state: 'missing', values: [], error: null }
          : { state: 'detected', values: [...addresses], error: null };
      }
      case 'AAAA': {
        const addresses = await resolver.resolve6(domain);
        return addresses.length === 0
          ? { state: 'missing', values: [], error: null }
          : { state: 'detected', values: [...addresses], error: null };
      }
      case 'TXT_SPF': {
        const txts = await resolver.resolveTxt(domain);
        const matches = txts.map(joinTxtRecord).filter((r) => SPF_PREFIX_PATTERN.test(r));
        return matches.length === 0
          ? { state: 'missing', values: [], error: null }
          : { state: 'detected', values: matches, error: null };
      }
      case 'TXT_DMARC': {
        const txts = await resolver.resolveTxt(`_dmarc.${domain}`);
        const matches = txts.map(joinTxtRecord).filter((r) => DMARC_PREFIX_PATTERN.test(r));
        return matches.length === 0
          ? { state: 'missing', values: [], error: null }
          : { state: 'detected', values: matches, error: null };
      }
      case 'TXT_DKIM': {
        const txts = await resolver.resolveTxt(`${selector}._domainkey.${domain}`);
        const joined = txts.map(joinTxtRecord);
        return joined.length === 0
          ? { state: 'missing', values: [], error: null }
          : { state: 'detected', values: joined, error: null };
      }
    }
  } catch (err) {
    const failure = classifyDnsError(err);
    return failure === 'missing'
      ? { state: 'missing', values: [], error: null }
      : { state: 'unknown', values: [], error: describeDnsError(err) };
  }
}

export async function checkPropagation(
  createResolver: DnsLookupPortFactory,
  domain: string,
  recordType: PropagationRecordType,
  selector: string = DEFAULT_DKIM_SELECTOR,
): Promise<PropagationReport> {
  const results = await Promise.all(
    PUBLIC_RESOLVERS.map(async (publicResolver) => {
      const resolver = createResolver(publicResolver.address);
      const outcome = await resolveOneRecord(resolver, domain, recordType, selector);
      return {
        resolverName: publicResolver.name,
        resolverAddress: publicResolver.address,
        state: outcome.state,
        values: outcome.values,
        error: outcome.error,
      };
    }),
  );

  return {
    domain,
    recordType,
    checkedAt: new Date().toISOString(),
    results,
    caveat: PROPAGATION_CAVEAT,
  };
}
