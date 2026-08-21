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
  BackupVolumeKey,
  ConsoleCommand,
  ConsoleExecResponse,
  ContainerInspectResponse,
  ContainerLogLine,
  ContainerStatsResponse,
  ContainerSummary,
  ImagePruneResponse,
  ImageSummary,
  LogFileSource,
  NetworkSummary,
  SystemDfResponse,
  SystemInfoResponse,
  SystemPingResponse,
  SystemVersionResponse,
  VolumeSummary,
} from '@dwg/shared';

export interface ContainerListParams {
  /** Docker's own default: only running containers. `true` includes stopped ones. */
  readonly all?: boolean | undefined;
}

// `?: T | undefined` rather than a bare `?: T` throughout this file
// (AGENT_BRIEF.md §5): callers up the stack (`modules/docker/*.service.ts`)
// forward a query object whose own optional fields already carry explicit
// `undefined` (ultimately traced back to a zod `.optional()` inference),
// and `exactOptionalPropertyTypes` requires the parameter type to accept
// that explicitly rather than only "absent".
export interface ContainerLogsParams {
  readonly tail?: number | undefined;
  /** Unix seconds. */
  readonly since?: number | undefined;
  readonly timestamps?: boolean | undefined;
}

export interface LogsFileParams {
  readonly tail?: number | undefined;
}

/**
 * Thrown by any {@link BrokerClient} implementation for a failed broker
 * operation — a non-2xx HTTP response from the real broker
 * (`RealBrokerClient`), or a simulated equivalent from the fixture-backed
 * `FakeBrokerClient` (e.g. refusing to remove a protected volume, the same
 * way the real broker's `operations.ts` does). Defined once, here, so
 * `platform/errors.ts` has exactly one class to recognise regardless of
 * which driver is active (ARCHITECTURE.md §9) — a route/service never
 * needs to know which implementation produced it.
 */
export class BrokerRequestError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'BrokerRequestError';
    this.statusCode = statusCode;
  }
}

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
  /**
   * Removes one volume by name. Rejects (a {@link BrokerRequestError} with
   * `statusCode: 403`) when the volume backs a protected DMS data mount —
   * refused, never a prompt to override — mirroring the broker's own
   * `volume.remove` handler exactly, including in `FakeBrokerClient`.
   */
  volumeRemove(name: string): Promise<void>;
  /** Always "remove every dangling image" — there is no by-id overload; see broker.ts's `ImagePruneRequestSchema`. */
  imagePrune(): Promise<ImagePruneResponse>;
  /** Reads one of the fixed two-value log-file source enum — never a client-supplied path. */
  logsFile(source: LogFileSource, params?: LogsFileParams): Promise<readonly string[]>;
  /** Runs one of the fixed, zero-argument console command enum and returns its full output. */
  consoleExec(command: ConsoleCommand): Promise<ConsoleExecResponse>;
  /**
   * Streams the raw `tar` of one backup volume, untouched — the read half
   * of M10 backups (`modules/backups/backup-archive.ts`). Deliberately
   * outside the `call()`-less JSON operation model every method above
   * uses: `archive-routes.ts` (broker) is a dedicated streaming route, not
   * a `BrokerOperation`, because a volume can be many gigabytes and the
   * JSON `/v1/ops` contract is sized for small request/response bodies.
   * Still a *named intent* addressed by the same closed
   * {@link BackupVolumeKey} enum the broker owns the path mapping for —
   * there is no field anywhere in this call that could carry a path.
   */
  archiveGet(volumeKey: BackupVolumeKey): Promise<NodeJS.ReadableStream>;
  /**
   * The write half of {@link archiveGet} — restore's mechanism
   * (`modules/backups/backup-archive.ts`). Callers must confirm the
   * managed container is stopped before calling this; neither this method
   * nor the broker route behind it perform that check themselves (restore
   * is Tier 4 and that refusal happens earlier, at the route/service
   * layer — see `modules/backups/backups.service.ts`).
   */
  archivePut(volumeKey: BackupVolumeKey, tarStream: NodeJS.ReadableStream): Promise<void>;
}
