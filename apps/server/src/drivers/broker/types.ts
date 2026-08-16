/**
 * The web tier's only way to reach Docker (ARCHITECTURE.md §2, §7.2). One
 * method per {@link BrokerOperation} from `@dwg/shared`'s closed
 * vocabulary — there is deliberately no generic
 * `call(operation, params)` escape hatch, so nothing that holds a
 * `BrokerClient` can express an operation this interface does not
 * already name, no matter what a caller further up the stack was tricked
 * into wanting.
 *
 * Two implementations: {@link RealBrokerClient} (HTTP to the real
 * broker) and {@link FakeBrokerClient} (deterministic, in-memory,
 * fixture-seeded) — see `create-broker-client.ts` for how one is chosen
 * (ARCHITECTURE.md §7.2, §9).
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

export interface ContainerListParams {
  /** Docker's own default: only running containers. `true` includes stopped ones. */
  readonly all?: boolean;
}

export interface ContainerLogsParams {
  readonly tail?: number;
  /** Unix seconds. */
  readonly since?: number;
  readonly timestamps?: boolean;
}

export interface BrokerClient {
  containerList(params?: ContainerListParams): Promise<readonly ContainerSummary[]>;
  /** Targets the resolved managed (mail) container — there is no container-id parameter to pass one; see ARCHITECTURE.md §6. */
  containerInspect(): Promise<ContainerInspectResponse>;
  containerStart(): Promise<void>;
  containerStop(): Promise<void>;
  containerRestart(): Promise<void>;
  containerStats(): Promise<ContainerStatsResponse>;
  containerLogs(params?: ContainerLogsParams): Promise<readonly ContainerLogLine[]>;
  systemPing(): Promise<SystemPingResponse>;
  systemVersion(): Promise<SystemVersionResponse>;
  systemInfo(): Promise<SystemInfoResponse>;
  systemDf(): Promise<SystemDfResponse>;
  imageList(): Promise<readonly ImageSummary[]>;
  volumeList(): Promise<readonly VolumeSummary[]>;
  networkList(): Promise<readonly NetworkSummary[]>;
}
