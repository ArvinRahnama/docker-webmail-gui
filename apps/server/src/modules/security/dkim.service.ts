/**
 * DKIM service (FEATURE_MATRIX.md §11) — generate → publish → verify.
 * "Publish" is the one step this panel deliberately does not perform: we
 * have no route to the admin's real DNS provider, and the SSRF-safe
 * design here is DNS **resolution** only (SECURITY.md §3.4), never an
 * outbound write to anything. "Generate" and "verify" are both real:
 * generate invokes `setup config dkim` through the DMS driver (never
 * touching a private key — `drivers/dms/exec-port.ts`'s doc comment);
 * verify re-runs the DNS-side DKIM check (`drivers/dns/dkim-dns.ts`) and
 * compares its public-key material against what the DMS driver's own
 * zone-file record says, so the UI can state plainly whether DNS has
 * caught up yet — with the propagation caveat, never a bare "done".
 */
import {
  checkDkimDns,
  extractPublicKeyTag,
  DEFAULT_DKIM_SELECTOR,
  validateHostnameForDns,
  type DnsLookupPort,
} from '../../drivers/dns/index.js';
import { validateDkimSelector } from '@dwg/shared';
import type { DmsDriver } from '../../drivers/dms/index.js';
import { AppError } from '../../platform/errors.js';
import type { DkimKeysize, DkimStatus } from '@dwg/shared';

function assertValidDomain(domain: string): string {
  const normalized = domain.trim().toLowerCase();
  const result = validateHostnameForDns(normalized);
  if (!result.ok) throw new AppError('VALIDATION_FAILED', result.error ?? 'Invalid domain.');
  return normalized;
}

function assertValidSelector(selector: string): string {
  const error = validateDkimSelector(selector);
  if (error) throw new AppError('VALIDATION_FAILED', error);
  return selector;
}

export interface GenerateDkimParams {
  readonly selector?: string;
  readonly keysize?: DkimKeysize;
}

export class DkimService {
  constructor(
    private readonly dmsDriver: DmsDriver,
    private readonly resolver: DnsLookupPort,
  ) {}

  async getStatus(domainInput: string, selectorInput?: string): Promise<DkimStatus> {
    const domain = assertValidDomain(domainInput);
    const selector = assertValidSelector(selectorInput ?? DEFAULT_DKIM_SELECTOR);

    const [recordResult, dnsCheck] = await Promise.all([
      this.dmsDriver.getDkimRecord(domain, selector),
      checkDkimDns(this.resolver, domain, selector),
    ]);

    const publicRecord = recordResult.ok
      ? { name: recordResult.record.name, value: recordResult.record.value }
      : null;

    const matchesDns = computeMatchesDns(publicRecord?.value ?? null, dnsCheck.record);

    return {
      domain,
      selector,
      keysize: null, // Not derivable from the zone-file text alone — reported honestly as unknown rather than guessed (see the schema's own doc comment).
      publicRecord,
      dnsCheck,
      matchesDns,
    };
  }

  async generate(domainInput: string, params: GenerateDkimParams = {}): Promise<DkimStatus> {
    const domain = assertValidDomain(domainInput);
    const selector = assertValidSelector(params.selector ?? DEFAULT_DKIM_SELECTOR);

    await this.dmsDriver.generateDkim({
      domains: [domain],
      selector,
      ...(params.keysize !== undefined ? { keysize: params.keysize } : {}),
    });

    return this.getStatus(domain, selector);
  }
}

/**
 * Compares just the `p=` public-key material on each side — not the
 * whole record text — so incidental formatting differences between "what
 * the DMS driver's zone file says" and "what a DNS TXT lookup returned"
 * never produce a false "does not match". `null` (never a guessed
 * boolean) whenever either side is unavailable.
 */
function computeMatchesDns(storedValue: string | null, dnsValue: string | null): boolean | null {
  if (storedValue === null || dnsValue === null) return null;
  const storedKey = extractPublicKeyTag(storedValue);
  const dnsKey = extractPublicKeyTag(dnsValue);
  if (storedKey === null || dnsKey === null) return null;
  return storedKey === dnsKey;
}
