/**
 * Selects the default {@link DnsLookupPort}, mirroring
 * `drivers/dms/create-dms-driver.ts`. Unlike the DMS driver, a real DNS
 * resolver carries none of the host-compromise risk `DANGEROUSLY_USE_REAL_DOCKER`
 * exists to gate — this reuses that same flag purely for the *dev-ergonomics*
 * convention it already establishes ("real external calls only in
 * production, or when explicitly opted into locally"), not because DNS
 * resolution is itself dangerous. The default stays fake in development
 * and in every automated test so neither ever depends on outbound network
 * access (IMPLEMENTATION_PLAN.md §2.4: "No live Rspamd/ClamAV/DNS" outside
 * CI's dedicated Phase 12).
 */
import type { Logger } from 'pino';
import type { AppConfig } from '../../platform/config.js';
import { FakeDnsLookupPort } from './fake-resolver.js';
import { createRealDnsLookupPort } from './real-resolver.js';
import type { DnsLookupPort } from './types.js';
import type { DnsLookupPortFactory } from './propagation.js';

export function createDnsLookupPort(config: AppConfig, logger: Logger): DnsLookupPort {
  const useReal = config.isProduction || config.dangerouslyUseRealDocker;
  if (useReal) {
    logger.info('DNS resolver: RealDnsLookupPort');
    return createRealDnsLookupPort();
  }
  logger.info('DNS resolver: FakeDnsLookupPort (development mode; no outbound DNS required)');
  return new FakeDnsLookupPort();
}

/** Same selection, but as a per-address factory for `propagation.ts` (`checkPropagation`'s first argument). */
export function createDnsLookupPortFactory(
  config: AppConfig,
  logger: Logger,
): DnsLookupPortFactory {
  const useReal = config.isProduction || config.dangerouslyUseRealDocker;
  if (useReal) {
    logger.info('DNS resolver factory: RealDnsLookupPort (per-resolver)');
    return (servers) => createRealDnsLookupPort({ servers: [servers] });
  }
  logger.info(
    'DNS resolver factory: FakeDnsLookupPort (development mode; no outbound DNS required)',
  );
  // A single shared fake for every resolver address in development — it
  // has no per-address state (`fake-resolver.ts` is domain-keyed, not
  // server-keyed), so reusing one instance is equivalent to constructing
  // a fresh one per call.
  const shared = new FakeDnsLookupPort();
  return () => shared;
}
