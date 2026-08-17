/**
 * Selects the default {@link TlsCertificateSourcePort}, mirroring
 * `drivers/dns/create-dns-resolver.ts` exactly, including its "reuses the
 * Docker-named flag purely for the dev-ergonomics convention, not because
 * this carries the same risk" reasoning.
 */
import type { Logger } from 'pino';
import type { AppConfig } from '../../platform/config.js';
import { FakeTlsCertificateSource } from './fake-tls-source.js';
import { createRealTlsCertificateSource } from './real-tls-source.js';
import type { TlsCertificateSourcePort } from './types.js';

export function createTlsCertificateSource(
  config: AppConfig,
  logger: Logger,
): TlsCertificateSourcePort {
  const useReal = config.isProduction || config.dangerouslyUseRealDocker;
  if (useReal) {
    logger.info('TLS certificate source: RealTlsCertificateSource');
    return createRealTlsCertificateSource();
  }
  logger.info(
    'TLS certificate source: FakeTlsCertificateSource (development mode; no outbound connections required)',
  );
  return new FakeTlsCertificateSource();
}
