/**
 * Selects the default {@link RspamdClientPort}, mirroring
 * `drivers/dns/create-dns-resolver.ts`. `config.rspamd.url`/`.password`
 * already exist on `AppConfig` (`platform/config.ts`), predating this
 * milestone.
 */
import type { Logger } from 'pino';
import type { AppConfig } from '../../platform/config.js';
import { FakeRspamdClient } from './fake-client.js';
import { createRealRspamdClient } from './real-client.js';
import type { RspamdClientPort } from './types.js';

export function createRspamdClient(config: AppConfig, logger: Logger): RspamdClientPort {
  const useReal = config.isProduction || config.dangerouslyUseRealDocker;
  if (useReal) {
    logger.info('Rspamd client: RealRspamdClient');
    return createRealRspamdClient({ baseUrl: config.rspamd.url, password: config.rspamd.password });
  }
  logger.info('Rspamd client: FakeRspamdClient (development mode; no live controller required)');
  return new FakeRspamdClient();
}
