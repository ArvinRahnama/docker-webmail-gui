/**
 * Networks service (M9 — FEATURE_MATRIX.md §26, "Full (read-only)";
 * AGENT_BRIEF.md §4 lists networks read-only for the same reason). There
 * is no mutating method here, and no mutating operation exists in the
 * broker protocol for networks at all.
 */
import type { NetworkSummary } from '@dwg/shared';
import type { BrokerClient } from '../../drivers/broker/types.js';

export class NetworksService {
  constructor(private readonly broker: BrokerClient) {}

  async list(): Promise<readonly NetworkSummary[]> {
    return this.broker.networkList();
  }
}
