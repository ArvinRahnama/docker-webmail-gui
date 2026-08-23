/**
 * Selects the DMS driver, mirroring `drivers/broker/create-broker-client.ts`.
 * Real in production and whenever `DANGEROUSLY_USE_REAL_DOCKER` is
 * explicitly set in development (unconditionally `false` in production —
 * `AppConfig.isProduction` already guarantees that, same reasoning as the
 * broker's factory); fake otherwise.
 *
 * Until M16 the real branch could not be taken at all: `DmsExecPort` had
 * no implementation, because implementing it meant adding `exec.run(argv)`
 * and `file.read(path)` to the broker, and both are the passthrough
 * AGENT_BRIEF.md §2 forbids. So this function threw, and the server could
 * not start in production. M16 replaced that port with the `dms.*` named
 * operations, and {@link BrokerDmsExecPort} is the adapter that speaks
 * them over the same `BrokerClient` every Docker operation already uses —
 * so the real branch is now reachable, and the throw is gone.
 */
import type { Logger } from 'pino';
import type { AppConfig } from '../../platform/config.js';
import type { BrokerClient } from '../broker/types.js';
import { BrokerDmsExecPort } from './broker-dms-exec-port.js';
import type { DmsExecPort } from './exec-port.js';
import { FakeDmsDriver } from './fake-dms-driver.js';
import { RealDmsDriver } from './real-dms-driver.js';
import type { DmsDriver } from './types.js';

/**
 * `execPort` is an explicit override, used by tests that want to record
 * what the driver asked for. Normal callers pass `broker` and let this
 * function build the adapter — which keeps the "which port does the real
 * driver get" decision in one place rather than at every call site.
 */
export function createDmsDriver(
  config: AppConfig,
  logger: Logger,
  broker: BrokerClient,
  execPort?: DmsExecPort,
): DmsDriver {
  const useReal = config.isProduction || config.dangerouslyUseRealDocker;

  if (useReal) {
    logger.info('DMS driver: RealDmsDriver (over the broker)');
    return new RealDmsDriver(execPort ?? new BrokerDmsExecPort(broker));
  }

  logger.info(
    'DMS driver: FakeDmsDriver (development mode; no docker-mailserver container required)',
  );
  return new FakeDmsDriver();
}
