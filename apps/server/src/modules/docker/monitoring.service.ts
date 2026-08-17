/**
 * Monitoring service (M9 — FEATURE_MATRIX.md §26). One read-only snapshot
 * combining the managed container's resource stats with host-level Docker
 * system info/version/disk-usage — four independent broker calls fetched
 * together so one screen renders from a single request. Nothing here is a
 * time series: the "spam trend"-style sampling this project uses elsewhere
 * (`rspamd-sampler.ts`) has no equivalent here yet — this is a live
 * snapshot only, matching what `container.stats`/`system.*` actually give
 * the broker in one call (docs/research/02-docker-api-security.md §A.3).
 */
import type { MonitoringResponse } from '@dwg/shared';
import type { BrokerClient } from '../../drivers/broker/types.js';

export class MonitoringService {
  constructor(private readonly broker: BrokerClient) {}

  async getSnapshot(): Promise<MonitoringResponse> {
    const [stats, system, version, df] = await Promise.all([
      this.broker.containerStats(),
      this.broker.systemInfo(),
      this.broker.systemVersion(),
      this.broker.systemDf(),
    ]);
    return { stats, system, version, df };
  }
}
