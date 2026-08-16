/**
 * `apps/server/src/drivers/broker` — the web tier's only path to Docker.
 * See `types.ts` for the interface, `real-broker-client.ts` /
 * `fake-broker-client.ts` for the two implementations, and
 * `create-broker-client.ts` for how one is selected (ARCHITECTURE.md
 * §7.2, §9).
 */
export type { BrokerClient, ContainerListParams, ContainerLogsParams } from './types.js';
export {
  RealBrokerClient,
  BrokerRequestError,
  type RealBrokerClientOptions,
} from './real-broker-client.js';
export { FakeBrokerClient } from './fake-broker-client.js';
export { createBrokerClient } from './create-broker-client.js';
