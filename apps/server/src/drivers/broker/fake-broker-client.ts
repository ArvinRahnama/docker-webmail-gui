/**
 * Deterministic, in-memory {@link BrokerClient} seeded from fixtures
 * (ARCHITECTURE.md §9). Touches no network, no socket, no real Docker
 * daemon. **The default in development mode** — see
 * `create-broker-client.ts` — so the panel is fully developable on a
 * machine with no Docker at all, and a developer cannot restart their
 * own containers by accident.
 */
import type {
  ContainerInspectResponse,
  ContainerLogLine,
  ContainerStatsResponse,
  ContainerSummary,
  ImageSummary,
  NetworkSummary,
  SystemDfResponse,
  SystemInfoResponse,
  SystemPingResponse,
  SystemVersionResponse,
  VolumeSummary,
} from '@dwg/shared';
import type { BrokerClient, ContainerListParams, ContainerLogsParams } from './types.js';
import {
  FIXTURE_CONTAINERS,
  FIXTURE_CONTAINER_INSPECT_RUNNING,
  FIXTURE_CONTAINER_INSPECT_STOPPED,
  FIXTURE_CONTAINER_STATS,
  FIXTURE_IMAGES,
  FIXTURE_LOG_LINES,
  FIXTURE_NETWORKS,
  FIXTURE_SYSTEM_DF,
  FIXTURE_SYSTEM_INFO,
  FIXTURE_SYSTEM_PING,
  FIXTURE_SYSTEM_VERSION,
  FIXTURE_VOLUMES,
} from './fixtures/index.js';

export class FakeBrokerClient implements BrokerClient {
  /**
   * The one piece of mutable state this fake tracks: start/stop/restart
   * observably change what a following `containerInspect()`/
   * `containerList()` reports, which is what makes the fake usable for
   * exercising a UI flow ("stop, see it go to exited, start it again")
   * rather than only ever returning one frozen snapshot.
   */
  private running = true;

  async containerList(params: ContainerListParams = {}): Promise<readonly ContainerSummary[]> {
    const all = params.all ?? false;
    const containers = FIXTURE_CONTAINERS.map((container) => ({
      ...container,
      state: this.running ? container.state : 'exited',
      status: this.running ? container.status : 'Exited (0) 2 minutes ago',
    }));
    return all ? containers : containers.filter((c) => c.state === 'running');
  }

  async containerInspect(): Promise<ContainerInspectResponse> {
    return this.running ? FIXTURE_CONTAINER_INSPECT_RUNNING : FIXTURE_CONTAINER_INSPECT_STOPPED;
  }

  async containerStart(): Promise<void> {
    this.running = true;
  }

  async containerStop(): Promise<void> {
    this.running = false;
  }

  async containerRestart(): Promise<void> {
    this.running = true;
  }

  async containerStats(): Promise<ContainerStatsResponse> {
    return { ...FIXTURE_CONTAINER_STATS, sampledAt: new Date().toISOString() };
  }

  async containerLogs(params: ContainerLogsParams = {}): Promise<readonly ContainerLogLine[]> {
    const tail = params.tail ?? FIXTURE_LOG_LINES.length;
    return FIXTURE_LOG_LINES.slice(-tail);
  }

  async systemPing(): Promise<SystemPingResponse> {
    return FIXTURE_SYSTEM_PING;
  }

  async systemVersion(): Promise<SystemVersionResponse> {
    return FIXTURE_SYSTEM_VERSION;
  }

  async systemInfo(): Promise<SystemInfoResponse> {
    return FIXTURE_SYSTEM_INFO;
  }

  async systemDf(): Promise<SystemDfResponse> {
    return FIXTURE_SYSTEM_DF;
  }

  async imageList(): Promise<readonly ImageSummary[]> {
    return FIXTURE_IMAGES;
  }

  async volumeList(): Promise<readonly VolumeSummary[]> {
    return FIXTURE_VOLUMES;
  }

  async networkList(): Promise<readonly NetworkSummary[]> {
    return FIXTURE_NETWORKS;
  }
}
