/**
 * Networks service (M9 — FEATURE_MATRIX.md §24). Read-only
 * (AGENT_BRIEF.md §4: "Networks — Read-only.") — there is no mutating
 * method here, and no mutating operation exists in the broker protocol
 * for networks at all.
 */
import type { NetworkSummary } from '@dwg/shared';
import type { BrokerClient } from '../../drivers/broker/types.js';

export class NetworksService {
  constructor(private readonly broker: BrokerClient) {}

  async list(): Promise<readonly NetworkSummary[]> {
    return this.broker.networkList();
  }
}
