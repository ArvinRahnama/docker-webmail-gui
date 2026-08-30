/**
 * Containers service (M9 — FEATURE_MATRIX.md §22-23). A thin wrapper over
 * `BrokerClient`: every method here is one broker operation, with no
 * business logic of its own to test independently of the broker contract
 * — mirroring `Fail2banService`'s shape for a module this simple. Lifecycle
 * actions (start/stop/restart) always target "the" managed mail
 * container — there is no by-id variant, matching the broker's own
 * container-identity resolution (ARCHITECTURE.md §6): the web tier never
 * names a container.
 */
import type { ContainerInspectResponse, ContainerSummary } from '@dwg/shared';
import type { BrokerClient } from '../../drivers/broker/types.js';

export class ContainersService {
  constructor(private readonly broker: BrokerClient) {}

  /** Every container Docker knows about, running or not — an admin visibility list, not scoped to the managed container alone. */
  async list(): Promise<readonly ContainerSummary[]> {
    return this.broker.containerList({ all: true });
  }

  /** Rich detail (state, health, restart count, mounts) for the one managed mail container. */
  async getManaged(): Promise<ContainerInspectResponse> {
    return this.broker.containerInspect();
  }

  async start(): Promise<void> {
    await this.broker.containerStart();
  }

  async stop(): Promise<void> {
    await this.broker.containerStop();
  }

  async restart(): Promise<void> {
    await this.broker.containerRestart();
  }

  /**
   * Restarts the panel's own server container (`panel.restart`). The
   * broker resolves the server identity and restarts the server only,
   * never itself. The server process is expected to be dropped mid-request
   * as it goes down, so the UI reconnects by polling `/api/v1/health`
   * rather than waiting on this call.
   */
  async restartPanel(): Promise<void> {
    await this.broker.panelRestart();
  }
}
