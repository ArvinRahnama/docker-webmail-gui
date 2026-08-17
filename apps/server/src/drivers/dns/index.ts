/**
 * `apps/server/src/drivers/dns` — DNS diagnostics driver (M8;
 * FEATURE_MATRIX.md §10). See `types.ts` for the `DnsLookupPort`
 * interface, `real-resolver.ts`/`fake-resolver.ts` for the two
 * implementations, `create-dns-resolver.ts` for how one is selected —
 * mirrors `drivers/dms/index.ts`.
 */
export type { DnsLookupPort, DnsMxRecord } from './types.js';
export { RealDnsLookupPort, createRealDnsLookupPort } from './real-resolver.js';
export { FakeDnsLookupPort, type FakeDnsRecordSet } from './fake-resolver.js';
export { createDnsLookupPort, createDnsLookupPortFactory } from './create-dns-resolver.js';
export { classifyDnsError, describeDnsError, type DnsFailureClass } from './errors.js';
export { validateHostnameForDns, isValidHostnameForDns } from './hostname.js';
export { checkSpf } from './spf.js';
export { checkDmarc } from './dmarc.js';
export { checkDkimDns, extractPublicKeyTag } from './dkim-dns.js';
export { checkPtr } from './ptr.js';
export { checkEmailAuth, DEFAULT_DKIM_SELECTOR, type CheckEmailAuthOptions } from './email-auth.js';
export { checkPropagation, PUBLIC_RESOLVERS, PROPAGATION_CAVEAT } from './propagation.js';
export type { DnsLookupPortFactory, PublicResolver } from './propagation.js';
