/**
 * Dispatches a validated {@link BrokerRequest} to its handler. This is
 * the broker's closed vocabulary made executable: every branch below is
 * one Docker call (via {@link DockerApi}, never `dockerode` directly —
 * see `docker-types.ts`), and the `default` branch is an exhaustiveness
 * guard, not a passthrough — TypeScript proves every real operation is
 * handled above it via the `never` narrowing, so it exists only to fail
 * loudly if that proof is ever broken, never to forward an operation
 * this file forgot to handle.
 *
 * **Scope note on "streaming" (ARCHITECTURE.md §6):** `container.logs`
 * and `container.stats` both return a single computed/decoded JSON body
 * per call here, not an open chunked connection that follows Docker
 * indefinitely. `container.logs` always asks Docker for bounded history
 * (`follow: false`) and demuxes it in one pass; `container.stats` asks
 * for one `stream:false` snapshot (docs/research/02-docker-api-security.md
 * §A.3 — this is the correct way to get a single sample with valid
 * `precpu_stats`, not `one-shot`). Live tailing/polling is a UI-facing
 * concern layered on top by repeated calls plus the server's own SSE
 * (ARCHITECTURE.md §8) — there is no real Docker daemon in this
 * environment to validate a long-lived follow connection against, and it
 * is not part of this milestone's acceptance criteria. What *is* fully
 * implemented and tested here is the hard part either design needs
 * regardless: correct demuxing (`stream-demux.ts`) and correct stats
 * maths (`stats.ts`).
 */
import type { Logger } from 'pino';
import {
  LOGS_TAIL_DEFAULT,
  type BrokerRequest,
  type ContainerInspectResponse,
  type ContainerListResponse,
  type ContainerLogsResponse,
  type ContainerStatsResponse,
  type ImageListResponse,
  type NetworkListResponse,
  type OperationAck,
  type SystemDfResponse,
  type SystemInfoResponse,
  type SystemPingResponse,
  type SystemVersionResponse,
  type VolumeListResponse,
} from '@dwg/shared';
import type { DockerApi, RawContainerListItem } from './docker-types.js';
import {
  ContainerResolutionError,
  resolveManagedContainer,
  type DmsIdentity,
  type ManagedContainerRef,
} from './container-resolver.js';
import { demuxDockerStream } from './stream-demux.js';
import { computeContainerStats } from './stats.js';
import { BrokerError } from './errors.js';

export interface OperationDeps {
  readonly docker: DockerApi;
  readonly dms: DmsIdentity;
  readonly logger: Logger;
}

async function resolveOrForbid(deps: OperationDeps): Promise<ManagedContainerRef> {
  try {
    return await resolveManagedContainer(deps.docker, deps.dms);
  } catch (err) {
    if (err instanceof ContainerResolutionError) {
      deps.logger.warn(
        { reason: err.reason },
        'Refusing operation: the managed container did not resolve to exactly one allowlisted match',
      );
      throw new BrokerError(
        'FORBIDDEN',
        'The managed container could not be resolved to a single allowlisted match.',
      );
    }
    throw err;
  }
}

/** Wraps a Docker call so a daemon-side failure never reaches the caller as a raw error — full detail is logged server-side, the client gets a stable `UPSTREAM_UNAVAILABLE`. */
async function callDocker<T>(
  deps: OperationDeps,
  action: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    deps.logger.error({ err, action }, 'Docker API call failed');
    throw new BrokerError('UPSTREAM_UNAVAILABLE', 'The Docker daemon call failed.');
  }
}

function toContainerSummary(
  raw: RawContainerListItem,
): ContainerListResponse['containers'][number] {
  return {
    id: raw.id,
    names: [...raw.names],
    image: raw.image,
    state: raw.state,
    status: raw.status,
    labels: { ...raw.labels },
    createdAt: raw.createdAt,
  };
}

async function handleContainerList(
  body: Extract<BrokerRequest, { operation: 'container.list' }>,
  deps: OperationDeps,
): Promise<ContainerListResponse> {
  const raw = await callDocker(deps, 'container.list', () =>
    deps.docker.listContainers({ all: body.all ?? false }),
  );
  return { containers: raw.map(toContainerSummary) };
}

async function handleContainerInspect(deps: OperationDeps): Promise<ContainerInspectResponse> {
  const ref = await resolveOrForbid(deps);
  const raw = await callDocker(deps, 'container.inspect', () =>
    deps.docker.inspectContainer(ref.id),
  );
  return {
    id: raw.id,
    name: raw.name,
    image: raw.image,
    createdAt: raw.createdAt,
    state: { ...raw.state },
    restartCount: raw.restartCount,
    labels: { ...raw.labels },
  };
}

async function handleContainerStart(deps: OperationDeps): Promise<OperationAck> {
  const ref = await resolveOrForbid(deps);
  await callDocker(deps, 'container.start', () => deps.docker.startContainer(ref.id));
  return { ok: true };
}

async function handleContainerStop(deps: OperationDeps): Promise<OperationAck> {
  const ref = await resolveOrForbid(deps);
  await callDocker(deps, 'container.stop', () => deps.docker.stopContainer(ref.id));
  return { ok: true };
}

async function handleContainerRestart(deps: OperationDeps): Promise<OperationAck> {
  const ref = await resolveOrForbid(deps);
  await callDocker(deps, 'container.restart', () => deps.docker.restartContainer(ref.id));
  return { ok: true };
}

async function handleContainerStats(deps: OperationDeps): Promise<ContainerStatsResponse> {
  const ref = await resolveOrForbid(deps);
  const raw = await callDocker(deps, 'container.stats', () => deps.docker.statsContainer(ref.id));
  const computed = computeContainerStats(raw);
  return { ...computed, sampledAt: new Date().toISOString() };
}

async function handleContainerLogs(
  body: Extract<BrokerRequest, { operation: 'container.logs' }>,
  deps: OperationDeps,
): Promise<ContainerLogsResponse> {
  const ref = await resolveOrForbid(deps);
  const inspection = await callDocker(deps, 'container.inspect', () =>
    deps.docker.inspectContainer(ref.id),
  );
  const buffer = await callDocker(deps, 'container.logs', () =>
    deps.docker.logsContainer(ref.id, {
      tail: body.tail ?? LOGS_TAIL_DEFAULT,
      timestamps: body.timestamps ?? false,
      // Spread rather than `since: body.since`: with
      // `exactOptionalPropertyTypes` (tsconfig.base.json), an optional
      // property must be *omitted* to mean "absent", not explicitly set
      // to `undefined` — this keeps "since was not requested" and
      // "since was requested as undefined" from being conflated.
      ...(body.since !== undefined ? { since: body.since } : {}),
    }),
  );
  const frames = demuxDockerStream(buffer, { tty: inspection.tty });
  return {
    lines: frames.map((frame) => ({ stream: frame.stream, data: frame.data.toString('utf8') })),
  };
}

async function handleSystemPing(deps: OperationDeps): Promise<SystemPingResponse> {
  // A successful `ping()` proves the daemon is reachable but its
  // resolved value is untyped and Docker puts the interesting field
  // (`Api-Version`) in a response *header* rather than the body
  // (docs/research/02-docker-api-security.md §A.0) — not something this
  // project's minimal `DockerApi.ping()` (Promise<void>) surfaces. Ping
  // first for the liveness check on its own terms, then read the same
  // field from `version()`'s well-documented JSON body, which every
  // daemon that answered ping will also answer.
  await callDocker(deps, 'system.ping', () => deps.docker.ping());
  const version = await callDocker(deps, 'system.version', () => deps.docker.version());
  return { apiVersion: version.apiVersion };
}

async function handleSystemVersion(deps: OperationDeps): Promise<SystemVersionResponse> {
  return callDocker(deps, 'system.version', () => deps.docker.version());
}

async function handleSystemInfo(deps: OperationDeps): Promise<SystemInfoResponse> {
  return callDocker(deps, 'system.info', () => deps.docker.info());
}

async function handleSystemDf(deps: OperationDeps): Promise<SystemDfResponse> {
  return callDocker(deps, 'system.df', () => deps.docker.df());
}

async function handleImageList(deps: OperationDeps): Promise<ImageListResponse> {
  const raw = await callDocker(deps, 'image.list', () => deps.docker.listImages());
  return {
    images: raw.map((image) => ({
      ...image,
      repoTags: [...image.repoTags],
      labels: { ...image.labels },
    })),
  };
}

async function handleVolumeList(deps: OperationDeps): Promise<VolumeListResponse> {
  const raw = await callDocker(deps, 'volume.list', () => deps.docker.listVolumes());
  return { volumes: raw.map((volume) => ({ ...volume, labels: { ...volume.labels } })) };
}

async function handleNetworkList(deps: OperationDeps): Promise<NetworkListResponse> {
  const raw = await callDocker(deps, 'network.list', () => deps.docker.listNetworks());
  return { networks: raw.map((network) => ({ ...network })) };
}

export async function handleOperation(body: BrokerRequest, deps: OperationDeps): Promise<unknown> {
  switch (body.operation) {
    case 'container.list':
      return handleContainerList(body, deps);
    case 'container.inspect':
      return handleContainerInspect(deps);
    case 'container.start':
      return handleContainerStart(deps);
    case 'container.stop':
      return handleContainerStop(deps);
    case 'container.restart':
      return handleContainerRestart(deps);
    case 'container.stats':
      return handleContainerStats(deps);
    case 'container.logs':
      return handleContainerLogs(body, deps);
    case 'system.ping':
      return handleSystemPing(deps);
    case 'system.version':
      return handleSystemVersion(deps);
    case 'system.info':
      return handleSystemInfo(deps);
    case 'system.df':
      return handleSystemDf(deps);
    case 'image.list':
      return handleImageList(deps);
    case 'volume.list':
      return handleVolumeList(deps);
    case 'network.list':
      return handleNetworkList(deps);
    default: {
      // Exhaustiveness guard, not a passthrough — see the file header.
      const exhaustive: never = body;
      throw new BrokerError(
        'VALIDATION_FAILED',
        `Unhandled operation: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}
