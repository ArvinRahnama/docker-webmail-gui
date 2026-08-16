/**
 * Selects the DMS driver, mirroring `drivers/broker/create-broker-client.ts`.
 * Real in production and whenever `DANGEROUSLY_USE_REAL_DOCKER` is
 * explicitly set in development (unconditionally `false` in production —
 * `AppConfig.isProduction` already guarantees that, same reasoning as the
 * broker's factory); fake otherwise, which is also every case today where
 * no `DmsExecPort` implementation exists to hand `RealDmsDriver` — see
 * `exec-port.ts`'s doc comment.
 */
import type { Logger } from 'pino';
import type { AppConfig } from '../../platform/config.js';
import type { DmsExecPort } from './exec-port.js';
import { FakeDmsDriver } from './fake-dms-driver.js';
import { RealDmsDriver } from './real-dms-driver.js';
import type { DmsDriver } from './types.js';

/**
 * `execPort` is optional because most callers today have no
 * `DmsExecPort` to give it (none is wired to the real broker yet).
 * Passing one only matters when `useReal` is also true; in that
 * combination, omitting it is a startup-time configuration error, not a
 * silent fallback to the fake — silently downgrading to fake data in what
 * was configured to be a real/production deployment would be far more
 * dangerous than failing loudly.
 */
export function createDmsDriver(
  config: AppConfig,
  logger: Logger,
  execPort?: DmsExecPort,
): DmsDriver {
  const useReal = config.isProduction || config.dangerouslyUseRealDocker;

  if (useReal) {
    if (!execPort) {
      throw new Error(
        'createDmsDriver: a real DmsExecPort is required because this deployment is configured to ' +
          'use real drivers, but none was provided. No concrete DmsExecPort adapter exists yet — see ' +
          "exec-port.ts's doc comment: the broker has no exec.run/file.read operation (M4 deferred " +
          'both). Wire an adapter before enabling DANGEROUSLY_USE_REAL_DOCKER or running in production.',
      );
    }
    logger.info('DMS driver: RealDmsDriver');
    return new RealDmsDriver(execPort);
  }

  logger.info(
    'DMS driver: FakeDmsDriver (development mode; no docker-mailserver container required)',
  );
  return new FakeDmsDriver();
}
