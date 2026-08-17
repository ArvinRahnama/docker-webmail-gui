/**
 * TanStack Query hooks over `lib/docker-api.ts`, mirroring
 * `security/use-security-queries.ts`'s shape.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConsoleCommand, LogFileSource } from '@dwg/shared';
import {
  execConsoleCommand,
  fetchConsoleAvailability,
  fetchContainerLogs,
  fetchContainers,
  fetchHealthChecks,
  fetchImages,
  fetchLogFile,
  fetchManagedContainer,
  fetchMonitoring,
  fetchNetworks,
  fetchVolumes,
  pruneImages,
  removeVolume,
  restartManagedContainer,
  startManagedContainer,
  stopManagedContainer,
  type ContainerLogsParams,
} from '@/lib/docker-api';

// ---------------------------------------------------------------------------
// Containers (FEATURE_MATRIX.md §24)
// ---------------------------------------------------------------------------

export const containersKey = ['docker', 'containers'] as const;
export const managedContainerKey = ['docker', 'containers', 'managed'] as const;

export function useContainersQuery() {
  return useQuery({ queryKey: containersKey, queryFn: fetchContainers });
}

export function useManagedContainerQuery() {
  return useQuery({ queryKey: managedContainerKey, queryFn: fetchManagedContainer });
}

function useLifecycleMutation(mutationFn: () => Promise<void>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: containersKey });
      void queryClient.invalidateQueries({ queryKey: managedContainerKey });
    },
  });
}

export function useStartContainerMutation() {
  return useLifecycleMutation(startManagedContainer);
}

export function useStopContainerMutation() {
  return useLifecycleMutation(stopManagedContainer);
}

export function useRestartContainerMutation() {
  return useLifecycleMutation(restartManagedContainer);
}

// ---------------------------------------------------------------------------
// Images (§24)
// ---------------------------------------------------------------------------

export const imagesKey = ['docker', 'images'] as const;

export function useImagesQuery() {
  return useQuery({ queryKey: imagesKey, queryFn: fetchImages });
}

export function usePruneImagesMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: pruneImages,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: imagesKey });
    },
  });
}

// ---------------------------------------------------------------------------
// Volumes (§25)
// ---------------------------------------------------------------------------

export const volumesKey = ['docker', 'volumes'] as const;

export function useVolumesQuery() {
  return useQuery({ queryKey: volumesKey, queryFn: fetchVolumes });
}

export function useRemoveVolumeMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: removeVolume,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: volumesKey });
    },
  });
}

// ---------------------------------------------------------------------------
// Networks (§24) — read-only.
// ---------------------------------------------------------------------------

export const networksKey = ['docker', 'networks'] as const;

export function useNetworksQuery() {
  return useQuery({ queryKey: networksKey, queryFn: fetchNetworks });
}

// ---------------------------------------------------------------------------
// Log viewer (§19-21, §26)
// ---------------------------------------------------------------------------

export const containerLogsKey = (params: ContainerLogsParams) =>
  ['docker', 'logs', 'container', params] as const;

export function useContainerLogsQuery(params: ContainerLogsParams = {}) {
  return useQuery({
    queryKey: containerLogsKey(params),
    queryFn: () => fetchContainerLogs(params),
  });
}

export const logFileKey = (source: LogFileSource, tail?: number) =>
  ['docker', 'logs', 'file', source, tail] as const;

export function useLogFileQuery(source: LogFileSource, tail?: number) {
  return useQuery({
    queryKey: logFileKey(source, tail),
    queryFn: () => fetchLogFile(source, { tail }),
  });
}

// ---------------------------------------------------------------------------
// Monitoring (§26)
// ---------------------------------------------------------------------------

export const monitoringKey = ['docker', 'monitoring'] as const;

export function useMonitoringQuery() {
  return useQuery({ queryKey: monitoringKey, queryFn: fetchMonitoring });
}

// ---------------------------------------------------------------------------
// Health centre (§26)
// ---------------------------------------------------------------------------

export const healthChecksKey = ['docker', 'health'] as const;

export function useHealthChecksQuery() {
  return useQuery({ queryKey: healthChecksKey, queryFn: fetchHealthChecks });
}

// ---------------------------------------------------------------------------
// Restricted console (§32)
// ---------------------------------------------------------------------------

export const consoleAvailabilityKey = ['docker', 'console'] as const;

export function useConsoleAvailabilityQuery() {
  return useQuery({ queryKey: consoleAvailabilityKey, queryFn: fetchConsoleAvailability });
}

export function useExecConsoleCommandMutation() {
  return useMutation({
    mutationFn: (command: ConsoleCommand) => execConsoleCommand(command),
  });
}
