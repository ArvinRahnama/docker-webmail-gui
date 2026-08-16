/**
 * Selects the broker driver (ARCHITECTURE.md §9). Real in production,
 * unconditionally. In development, fake unless
 * `DANGEROUSLY_USE_REAL_DOCKER` is explicitly set. `AppConfig.isProduction`
 * alone is sufficient for the production branch: `loadConfig` already
 * hardcodes `dangerouslyUseRealDocker` to `false` whenever
 * `isProduction` is true (`platform/config.ts`), so there is no env-var
 * combination that can make a production process pick the fake client.
 */
import type { Logger } from 'pino';
import type { AppConfig } from '../../platform/config.js';
import type { BrokerClient } from './types.js';
import { RealBrokerClient } from './real-broker-client.js';
import { FakeBrokerClient } from './fake-broker-client.js';

export function createBrokerClient(config: AppConfig, logger: Logger): BrokerClient {
  const useReal = config.isProduction || config.dangerouslyUseRealDocker;

  if (useReal) {
    logger.info({ brokerUrl: config.broker.url }, 'Broker driver: RealBrokerClient');
    return new RealBrokerClient({
      baseUrl: config.broker.url,
      sharedSecret: config.broker.sharedSecret,
    });
  }

  logger.info('Broker driver: FakeBrokerClient (development mode; no Docker daemon required)');
  return new FakeBrokerClient();
}
