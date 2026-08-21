/**
 * Typed wrappers over `/api/v1/docker/*`
 * (`apps/server/src/modules/docker/*.routes.ts`). Mirrors
 * `security-api.ts`'s shape.
 */
import {
  ConsoleAvailabilityResponseSchema,
  ConsoleExecResponseSchema,
  ContainerInspectResponseSchema,
  ContainerListResponseSchema,
  ContainerLogsResponseSchema,
  DockerVolumeListResponseSchema,
  HealthCentreResponseSchema,
  ImageListResponseSchema,
  ImagePruneResponseSchema,
  LogsFileResponseSchema,
  MonitoringResponseSchema,
  NetworkListResponseSchema,
  OperationAckSchema,
  type CapabilityStatus,
  type ConsoleCommand,
  type ConsoleExecResponse,
  type ContainerInspectResponse,
  type ContainerLogLine,
  type ContainerSummary,
  type DockerVolume,
  type HealthCheck,
  type ImagePruneResponse,
  type ImageSummary,
  type LogFileSource,
  type MonitoringResponse,
  type NetworkSummary,
} from '@dwg/shared';
import { request } from './api-client';

// ---------------------------------------------------------------------------
// Containers (FEATURE_MATRIX.md §22-23)
// ---------------------------------------------------------------------------

export async function fetchContainers(): Promise<readonly ContainerSummary[]> {
  const { containers } = await request('/api/v1/docker/containers', ContainerListResponseSchema, {
    method: 'GET',
  });
  return containers;
}

export async function fetchManagedContainer(): Promise<ContainerInspectResponse> {
  return request('/api/v1/docker/containers/managed', ContainerInspectResponseSchema, {
    method: 'GET',
  });
}

export async function startManagedContainer(): Promise<void> {
  await request('/api/v1/docker/containers/managed/start', OperationAckSchema, {
    method: 'POST',
  });
}

export async function stopManagedContainer(): Promise<void> {
  await request('/api/v1/docker/containers/managed/stop', OperationAckSchema, { method: 'POST' });
}

export async function restartManagedContainer(): Promise<void> {
  await request('/api/v1/docker/containers/managed/restart', OperationAckSchema, {
    method: 'POST',
  });
}

// ---------------------------------------------------------------------------
// Images (§24) — `prune` never takes an id; there is no by-id removal call.
// ---------------------------------------------------------------------------

export async function fetchImages(): Promise<readonly ImageSummary[]> {
  const { images } = await request('/api/v1/docker/images', ImageListResponseSchema, {
    method: 'GET',
  });
  return images;
}

export async function pruneImages(): Promise<ImagePruneResponse> {
  return request('/api/v1/docker/images/prune', ImagePruneResponseSchema, { method: 'POST' });
}

// ---------------------------------------------------------------------------
// Volumes (§25)
// ---------------------------------------------------------------------------

export async function fetchVolumes(): Promise<readonly DockerVolume[]> {
  const { volumes } = await request('/api/v1/docker/volumes', DockerVolumeListResponseSchema, {
    method: 'GET',
  });
  return volumes;
}

export async function removeVolume(name: string): Promise<void> {
  await request(`/api/v1/docker/volumes/${encodeURIComponent(name)}`, OperationAckSchema, {
    method: 'DELETE',
  });
}

// ---------------------------------------------------------------------------
// Networks (§24) — read-only.
// ---------------------------------------------------------------------------

export async function fetchNetworks(): Promise<readonly NetworkSummary[]> {
  const { networks } = await request('/api/v1/docker/networks', NetworkListResponseSchema, {
    method: 'GET',
  });
  return networks;
}

// ---------------------------------------------------------------------------
// Log viewer (§19-21, §26)
// ---------------------------------------------------------------------------

export interface ContainerLogsParams {
  readonly tail?: number | undefined;
  readonly since?: number | undefined;
  readonly timestamps?: boolean | undefined;
}

/**
 * Builds a `?a=1&b=2` query string from an ordered list of entries,
 * dropping any `undefined` value. Takes entries (built by each caller via
 * `Object.entries`) rather than the params object itself — `Object.entries`
 * already tolerates any plain object shape via its own `{}`-typed
 * overload, which sidesteps requiring every params interface in this file
 * to declare a redundant index signature just to satisfy a shared
 * `Record<string, …>` parameter type.
 */
function toQueryString(entries: readonly (readonly [string, unknown])[]): string {
  const present = entries.filter((entry): entry is [string, string | number | boolean] => {
    const [, value] = entry;
    return value !== undefined;
  });
  if (present.length === 0) return '';
  const search = new URLSearchParams(present.map(([key, value]) => [key, String(value)]));
  return `?${search.toString()}`;
}

export async function fetchContainerLogs(
  params: ContainerLogsParams = {},
): Promise<readonly ContainerLogLine[]> {
  const qs = toQueryString(Object.entries(params));
  const { lines } = await request(
    `/api/v1/docker/logs/container${qs}`,
    ContainerLogsResponseSchema,
    { method: 'GET' },
  );
  return lines;
}

export async function fetchLogFile(
  source: LogFileSource,
  params: { tail?: number | undefined } = {},
): Promise<readonly string[]> {
  const qs = toQueryString(Object.entries(params));
  const { lines } = await request(
    `/api/v1/docker/logs/file/${encodeURIComponent(source)}${qs}`,
    LogsFileResponseSchema,
    { method: 'GET' },
  );
  return lines;
}

// ---------------------------------------------------------------------------
// Monitoring (§26)
// ---------------------------------------------------------------------------

export async function fetchMonitoring(): Promise<MonitoringResponse> {
  return request('/api/v1/docker/monitoring', MonitoringResponseSchema, { method: 'GET' });
}

// ---------------------------------------------------------------------------
// Health centre (§26)
// ---------------------------------------------------------------------------

export async function fetchHealthChecks(): Promise<readonly HealthCheck[]> {
  const { checks } = await request('/api/v1/docker/health', HealthCentreResponseSchema, {
    method: 'GET',
  });
  return checks;
}

// ---------------------------------------------------------------------------
// Restricted console (§32) — off by default (`ENABLE_EXEC_CONSOLE`).
// ---------------------------------------------------------------------------

export async function fetchConsoleAvailability(): Promise<CapabilityStatus> {
  const { capability } = await request(
    '/api/v1/docker/console',
    ConsoleAvailabilityResponseSchema,
    { method: 'GET' },
  );
  return capability;
}

export async function execConsoleCommand(command: ConsoleCommand): Promise<ConsoleExecResponse> {
  return request('/api/v1/docker/console/exec', ConsoleExecResponseSchema, {
    method: 'POST',
    body: { command },
  });
}
