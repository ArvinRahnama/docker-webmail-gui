/**
 * TanStack Query hooks over `lib/mcp-api.ts`. Mutations that return a
 * one-time setup password return it to the caller only — it is never
 * written into the query cache.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateMcpConnectionRequest,
  McpSettingsPatch,
  UpdateMcpConnectionRequest,
} from '@dwg/shared';
import {
  createMcpConnection,
  deleteMcpConnection,
  fetchMcpConnection,
  fetchMcpConnectionAudit,
  fetchMcpConnections,
  fetchMcpMailboxOverview,
  fetchMcpSettings,
  fetchMcpStatus,
  reissueMcpCredential,
  revokeMcpGrant,
  rotateMcpCredential,
  runMcpDiscoveryCheck,
  setMcpConnectionState,
  testMcpConnection,
  updateMcpConnection,
  updateMcpMailboxCredential,
  updateMcpSettings,
  type McpConnectionListParams,
} from '@/lib/mcp-api';

export const mcpStatusKey = ['mcp', 'status'] as const;
export const mcpSettingsKey = ['mcp', 'settings'] as const;
export const mcpConnectionsKey = (params: McpConnectionListParams) =>
  ['mcp', 'connections', params] as const;
export const mcpConnectionKey = (id: string) => ['mcp', 'connection', id] as const;
export const mcpConnectionAuditKey = (id: string) => ['mcp', 'connection', id, 'audit'] as const;
export const mcpMailboxKey = (address: string) => ['mcp', 'mailbox', address] as const;

export function useMcpStatusQuery() {
  return useQuery({ queryKey: mcpStatusKey, queryFn: fetchMcpStatus, refetchInterval: 30_000 });
}

export function useMcpSettingsQuery(enabled = true) {
  return useQuery({ queryKey: mcpSettingsKey, queryFn: fetchMcpSettings, enabled });
}

export function useMcpConnectionsQuery(params: McpConnectionListParams, enabled = true) {
  return useQuery({
    queryKey: mcpConnectionsKey(params),
    queryFn: () => fetchMcpConnections(params),
    enabled,
  });
}

export function useMcpConnectionQuery(id: string) {
  return useQuery({
    queryKey: mcpConnectionKey(id),
    queryFn: () => fetchMcpConnection(id),
    enabled: id.length > 0,
  });
}

export function useMcpConnectionAuditQuery(id: string) {
  return useQuery({
    queryKey: mcpConnectionAuditKey(id),
    queryFn: () => fetchMcpConnectionAudit(id),
    enabled: id.length > 0,
  });
}

export function useMcpMailboxOverviewQuery(address: string, enabled = true) {
  return useQuery({
    queryKey: mcpMailboxKey(address),
    queryFn: () => fetchMcpMailboxOverview(address),
    enabled: enabled && address.length > 0,
    retry: false,
  });
}

/** Every MCP mutation can change counts, lists and details — invalidate the whole `mcp` prefix. */
function useInvalidateMcp() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: ['mcp'] });
}

export function useUpdateMcpSettingsMutation() {
  const invalidate = useInvalidateMcp();
  return useMutation({
    mutationFn: (patch: McpSettingsPatch) => updateMcpSettings(patch),
    onSuccess: invalidate,
  });
}

export function useMcpDiscoveryCheckMutation() {
  return useMutation({ mutationFn: runMcpDiscoveryCheck });
}

export function useCreateMcpConnectionMutation() {
  const invalidate = useInvalidateMcp();
  return useMutation({
    mutationFn: (input: CreateMcpConnectionRequest) => createMcpConnection(input),
    onSuccess: invalidate,
  });
}

export function useUpdateMcpConnectionMutation(id: string) {
  const invalidate = useInvalidateMcp();
  return useMutation({
    mutationFn: (input: UpdateMcpConnectionRequest) => updateMcpConnection(id, input),
    onSuccess: invalidate,
  });
}

export function useUpdateMcpMailboxCredentialMutation(id: string) {
  const invalidate = useInvalidateMcp();
  return useMutation({
    mutationFn: (password: string) => updateMcpMailboxCredential(id, password),
    onSuccess: invalidate,
  });
}

export function useReissueMcpCredentialMutation(id: string) {
  const invalidate = useInvalidateMcp();
  return useMutation({ mutationFn: () => reissueMcpCredential(id), onSuccess: invalidate });
}

export function useRotateMcpCredentialMutation(id: string) {
  const invalidate = useInvalidateMcp();
  return useMutation({ mutationFn: () => rotateMcpCredential(id), onSuccess: invalidate });
}

export function useTestMcpConnectionMutation(id: string) {
  const invalidate = useInvalidateMcp();
  return useMutation({ mutationFn: () => testMcpConnection(id), onSuccess: invalidate });
}

export function useSetMcpConnectionStateMutation(id: string) {
  const invalidate = useInvalidateMcp();
  return useMutation({
    mutationFn: ({
      action,
      reason,
    }: {
      action: 'disable' | 'enable' | 'revoke';
      reason?: string;
    }) => setMcpConnectionState(id, action, reason),
    onSuccess: invalidate,
  });
}

export function useDeleteMcpConnectionMutation(id: string) {
  const invalidate = useInvalidateMcp();
  return useMutation({ mutationFn: () => deleteMcpConnection(id), onSuccess: invalidate });
}

export function useRevokeMcpGrantMutation(id: string) {
  const invalidate = useInvalidateMcp();
  return useMutation({
    mutationFn: (grantId: string) => revokeMcpGrant(id, grantId),
    onSuccess: invalidate,
  });
}
