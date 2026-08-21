/**
 * Selects the registry driver, mirroring `drivers/broker/create-broker-client.ts`'s
 * shape and reasoning: real in production, fake otherwise. Unlike the
 * broker (where the escape hatch is `DANGEROUSLY_USE_REAL_DOCKER`,
 * because talking to a real Docker daemon risks a developer's own
 * containers), there is no equivalent risk in talking to a real public
 * registry — the risk here is only "tests/dev now depend on internet
 * access and an external service's uptime", which is reason enough to
 * default to the fake unconditionally in development, with no opt-in
 * flag at all.
 */
import type { Logger } from 'pino';
import type { AppConfig } from '../../platform/config.js';
import type { RegistryClientPort } from './types.js';
import { RealRegistryClient } from './real-registry-client.js';
import { FakeRegistryClient } from './fake-registry-client.js';

export function createRegistryClient(config: AppConfig, logger: Logger): RegistryClientPort {
  if (config.isProduction) {
    logger.info('Registry driver: RealRegistryClient');
    return new RealRegistryClient();
  }

  logger.info('Registry driver: FakeRegistryClient (development mode; no network access required)');
  return new FakeRegistryClient();
}
