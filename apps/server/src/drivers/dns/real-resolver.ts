/**
 * Real {@link DnsLookupPort}, backed directly by `node:dns/promises`'s
 * `Resolver` (`docs/research/03-mail-stack-components.md` §8). Unlike the
 * DMS driver's real implementation, this needs **no broker** — DNS
 * resolution runs from the Node server process itself, so this class is
 * genuinely usable in production today, not deferred behind broker
 * plumbing.
 *
 * `timeout`/`tries` bound every query (SECURITY.md §3.4: "timeout-bounded
 * and rate-limited" — the rate limiting half is enforced at the route
 * layer via `@fastify/rate-limit`, mirroring `auth.routes.ts`'s
 * `/login` scope). A fresh `Resolver` instance per construction call
 * means `setServers` (used by `propagation.ts` to pin one specific public
 * resolver per query) never mutates Node's global resolver configuration
 * or leaks between concurrent requests targeting different servers.
 */
import { Resolver } from 'node:dns/promises';
import type { DnsLookupPort, DnsMxRecord } from './types.js';

export interface RealDnsLookupPortOptions {
  /** Pins this instance to specific resolver IPs (propagation checks) instead of the system default. */
  readonly servers?: readonly string[];
  readonly timeoutMs?: number;
  readonly tries?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_TRIES = 3;

export class RealDnsLookupPort implements DnsLookupPort {
  private readonly resolver: Resolver;

  constructor(options: RealDnsLookupPortOptions = {}) {
    this.resolver = new Resolver({
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      tries: options.tries ?? DEFAULT_TRIES,
    });
    if (options.servers !== undefined && options.servers.length > 0) {
      this.resolver.setServers([...options.servers]);
    }
  }

  async resolveMx(hostname: string): Promise<readonly DnsMxRecord[]> {
    return this.resolver.resolveMx(hostname);
  }

  async resolveTxt(hostname: string): Promise<readonly (readonly string[])[]> {
    return this.resolver.resolveTxt(hostname);
  }

  async resolve4(hostname: string): Promise<readonly string[]> {
    return this.resolver.resolve4(hostname);
  }

  async resolve6(hostname: string): Promise<readonly string[]> {
    return this.resolver.resolve6(hostname);
  }

  async reverse(ip: string): Promise<readonly string[]> {
    return this.resolver.reverse(ip);
  }
}

/** Convenience factory matching `propagation.ts`'s `DnsLookupPortFactory` shape: one resolver address in, one fresh port out. */
export function createRealDnsLookupPort(options: RealDnsLookupPortOptions = {}): DnsLookupPort {
  return new RealDnsLookupPort(options);
}
