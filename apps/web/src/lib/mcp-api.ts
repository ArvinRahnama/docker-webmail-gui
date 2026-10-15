/**
 * Typed wrappers over `/api/v1/mcp/*` (apps/server/src/modules/mcp/mcp.routes.ts).
 * Each function is a path, a method, and the shared Zod schema for the
 * response — a contract change in `@dwg/shared` is a compile error here.
 *
 * Two of these responses carry a one-time setup password
 * (`createMcpConnection`, `reissueMcpCredential`/`rotateMcpCredential`).
 * Callers hand it straight to the one-time credential dialog's component
 * state; nothing here caches, logs or persists it, and TanStack Query never
 * sees it (mutations, not queries).
 */
import { z } from 'zod';
import {
  CreateMcpConnectionRequestSchema,
  CreateMcpConnectionResponseSchema,
  McpAuditListResponseSchema,
  McpConnectionDetailResponseSchema,
  McpConnectionListResponseSchema,
  McpConnectionTestResponseSchema,
  McpCredentialIssueResponseSchema,
  McpDiscoveryCheckResponseSchema,
  McpMailboxOverviewResponseSchema,
  McpSettingsPatchSchema,
  McpSettingsResponseSchema,
  McpStatusResponseSchema,
  UpdateMcpConnectionRequestSchema,
  UpdateMcpCredentialsRequestSchema,
  type CreateMcpConnectionRequest,
  type CreateMcpConnectionResponse,
  type McpAuditListResponse,
  type McpConnectionDetailResponse,
  type McpConnectionListResponse,
  type McpConnectionStatus,
  type McpConnectionTestResponse,
  type McpCredentialIssueResponse,
  type McpDiscoveryCheckResponse,
  type McpMailboxOverviewResponse,
  type McpSettingsPatch,
  type McpSettingsResponse,
  type McpStatusResponse,
  type UpdateMcpConnectionRequest,
} from '@dwg/shared';
import { request } from './api-client';

const BASE = '/api/v1/mcp';
const NoContentSchema = z.undefined();

export function fetchMcpStatus(): Promise<McpStatusResponse> {
  return request(`${BASE}/status`, McpStatusResponseSchema);
}

export function fetchMcpSettings(): Promise<McpSettingsResponse> {
  return request(`${BASE}/settings`, McpSettingsResponseSchema);
}

export function updateMcpSettings(patch: McpSettingsPatch): Promise<McpSettingsResponse> {
  const body = McpSettingsPatchSchema.parse(patch);
  return request(`${BASE}/settings`, McpSettingsResponseSchema, { method: 'PATCH', body });
}

export function runMcpDiscoveryCheck(): Promise<McpDiscoveryCheckResponse> {
  return request(`${BASE}/discovery-check`, McpDiscoveryCheckResponseSchema, {
    method: 'POST',
    body: {},
  });
}

export interface McpConnectionListParams {
  readonly search?: string | undefined;
  readonly status?: McpConnectionStatus | undefined;
  readonly mailbox?: string | undefined;
}

export function fetchMcpConnections(
  params: McpConnectionListParams = {},
): Promise<McpConnectionListResponse> {
  const search = new URLSearchParams();
  if (params.search) search.set('search', params.search);
  if (params.status) search.set('status', params.status);
  if (params.mailbox) search.set('mailbox', params.mailbox);
  const qs = search.toString();
  return request(`${BASE}/connections${qs ? `?${qs}` : ''}`, McpConnectionListResponseSchema);
}

export function fetchMcpConnection(id: string): Promise<McpConnectionDetailResponse> {
  return request(
    `${BASE}/connections/${encodeURIComponent(id)}`,
    McpConnectionDetailResponseSchema,
  );
}

export function createMcpConnection(
  input: CreateMcpConnectionRequest,
): Promise<CreateMcpConnectionResponse> {
  const body = CreateMcpConnectionRequestSchema.parse(input);
  return request(`${BASE}/connections`, CreateMcpConnectionResponseSchema, {
    method: 'POST',
    body,
  });
}

export function updateMcpConnection(
  id: string,
  input: UpdateMcpConnectionRequest,
): Promise<McpConnectionDetailResponse> {
  const body = UpdateMcpConnectionRequestSchema.parse(input);
  return request(
    `${BASE}/connections/${encodeURIComponent(id)}`,
    McpConnectionDetailResponseSchema,
    { method: 'PATCH', body },
  );
}

export function updateMcpMailboxCredential(
  id: string,
  mailboxPassword: string,
): Promise<McpConnectionDetailResponse> {
  const body = UpdateMcpCredentialsRequestSchema.parse({ mailboxPassword });
  return request(
    `${BASE}/connections/${encodeURIComponent(id)}/credentials`,
    McpConnectionDetailResponseSchema,
    {
      method: 'POST',
      body,
    },
  );
}

export function reissueMcpCredential(id: string): Promise<McpCredentialIssueResponse> {
  return request(
    `${BASE}/connections/${encodeURIComponent(id)}/reissue`,
    McpCredentialIssueResponseSchema,
    { method: 'POST', body: {} },
  );
}

export function rotateMcpCredential(id: string): Promise<McpCredentialIssueResponse> {
  return request(
    `${BASE}/connections/${encodeURIComponent(id)}/rotate`,
    McpCredentialIssueResponseSchema,
    { method: 'POST', body: {} },
  );
}

export function testMcpConnection(id: string): Promise<McpConnectionTestResponse> {
  return request(
    `${BASE}/connections/${encodeURIComponent(id)}/test`,
    McpConnectionTestResponseSchema,
    { method: 'POST', body: {} },
  );
}

export function setMcpConnectionState(
  id: string,
  action: 'disable' | 'enable' | 'revoke',
  reason?: string,
): Promise<McpConnectionDetailResponse> {
  return request(
    `${BASE}/connections/${encodeURIComponent(id)}/${action}`,
    McpConnectionDetailResponseSchema,
    {
      method: 'POST',
      body: reason !== undefined && reason.length > 0 ? { reason } : {},
    },
  );
}

export async function deleteMcpConnection(id: string): Promise<void> {
  await request(`${BASE}/connections/${encodeURIComponent(id)}`, NoContentSchema, {
    method: 'DELETE',
  });
}

export function revokeMcpGrant(id: string, grantId: string): Promise<McpConnectionDetailResponse> {
  return request(
    `${BASE}/connections/${encodeURIComponent(id)}/grants/${encodeURIComponent(grantId)}`,
    McpConnectionDetailResponseSchema,
    {
      method: 'DELETE',
    },
  );
}

export function fetchMcpConnectionAudit(id: string): Promise<McpAuditListResponse> {
  return request(`${BASE}/connections/${encodeURIComponent(id)}/audit`, McpAuditListResponseSchema);
}

export function fetchMcpMailboxOverview(address: string): Promise<McpMailboxOverviewResponse> {
  return request(
    `${BASE}/mailboxes/${encodeURIComponent(address)}`,
    McpMailboxOverviewResponseSchema,
  );
}
