/**
 * Selects the self-update release-source driver, mirroring
 * `drivers/registry/create-registry-client.ts`'s shape and reasoning
 * exactly: real in production, fake otherwise, no opt-in flag. There is
 * no equivalent of the broker's `DANGEROUSLY_USE_REAL_DOCKER` escape
 * hatch here for the same reason `create-registry-client.ts` has none —
 * talking to a real public API (GitHub's, this time, not a registry's)
 * risks nothing but "tests/dev now depend on internet access and an
 * external service's uptime", so the fake is the unconditional default
 * outside production.
 */
import type { Logger } from 'pino';
import type { AppConfig } from '../../platform/config.js';
import type { SelfUpdateReleaseSourcePort } from './types.js';
import { RealSelfUpdateReleaseSource } from './real-self-update-release-source.js';
import { FakeSelfUpdateReleaseSource } from './fake-self-update-release-source.js';

export function createSelfUpdateReleaseSource(
  config: AppConfig,
  logger: Logger,
): SelfUpdateReleaseSourcePort {
  if (config.isProduction) {
    logger.info('Self-update release source: RealSelfUpdateReleaseSource');
    return new RealSelfUpdateReleaseSource();
  }

  logger.info(
    'Self-update release source: FakeSelfUpdateReleaseSource (development mode; no network access required)',
  );
  return new FakeSelfUpdateReleaseSource();
}
