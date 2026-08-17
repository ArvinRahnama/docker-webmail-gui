/**
 * `DnsLookupPort` — the minimal DNS resolution surface every checker in
 * this driver (`spf.ts`, `dmarc.ts`, `dkim-dns.ts`, `ptr.ts`,
 * `email-auth.ts`, `propagation.ts`) is written against, mirroring
 * `drivers/dms/exec-port.ts`'s port pattern: real code depends on an
 * interface, not a concrete resolver, so every checker is unit-testable
 * against a hand-built fake with no real network call
 * (IMPLEMENTATION_PLAN.md §2.4 — "No live Rspamd/ClamAV/DNS" outside CI's
 * Phase 12).
 *
 * Unlike `DmsExecPort`, a real implementation of this port needs **no
 * broker** — DNS resolution runs directly from the Node server process
 * (`docs/research/03-mail-stack-components.md` §8), so `real-resolver.ts`
 * is a genuine, usable-today implementation, not one deferred behind
 * broker plumbing that does not exist yet.
 *
 * Every method returns exactly what Node's own `dns.promises.Resolver`
 * returns for the same call (including `resolveTxt`'s `string[][]`
 * chunking — each inner array is one TXT record's chunks, which the
 * caller must `.join('')`) and lets a real DNS error escape as a thrown
 * `NodeJS.ErrnoException`-shaped error for `classifyDnsError` (`errors.ts`)
 * to interpret — this port does not itself decide missing-vs-unknown.
 */

export interface DnsMxRecord {
  readonly exchange: string;
  readonly priority: number;
}

export interface DnsLookupPort {
  resolveMx(hostname: string): Promise<readonly DnsMxRecord[]>;
  /** One entry per TXT record found; each entry is that record's raw chunks, unjoined — matches `dns.promises.resolveTxt`. */
  resolveTxt(hostname: string): Promise<readonly (readonly string[])[]>;
  resolve4(hostname: string): Promise<readonly string[]>;
  resolve6(hostname: string): Promise<readonly string[]>;
  /** Reverse (PTR) lookup for a single IPv4/IPv6 address. */
  reverse(ip: string): Promise<readonly string[]>;
}
