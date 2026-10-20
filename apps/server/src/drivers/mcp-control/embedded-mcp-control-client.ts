/**
 * Client for the embedded MCP integration's control API
 * (docs/mcp-integration.md). The MCP component runs inside this process;
 * calls go through its in-process transport, which authenticates them and
 * runs the control API's own validation. Every response is validated again
 * here against the shared Zod contract before it reaches a route, so the
 * routes depend only on `@dwg/shared`.
 */
import { z } from 'zod';
import {
  ApiErrorEnvelopeSchema,
  CreateMcpConnectionResponseSchema,
  McpAuditListResponseSchema,
  McpConnectionDetailResponseSchema,
  McpConnectionListResponseSchema,
  McpConnectionTestResponseSchema,
  McpControlMailboxEventResponseSchema,
  McpControlReconcileResponseSchema,
  McpCredentialIssueResponseSchema,
  McpDiscoveryCheckResponseSchema,
  McpMailboxOverviewResponseSchema,
  McpServiceStatusSchema,
  McpSettingsResponseSchema,
  type McpConnectionListQuery,
} from '@dwg/shared';
import {
  McpControlRequestError,
  McpControlUnavailableError,
  type McpControlActor,
  type McpControlClient,
} from './types.js';

/** One control API call: method, path under `/control/v1`, optional JSON body. */
export type McpControlTransport = (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
) => Promise<{ readonly status: number; readonly text: string }>;

export class EmbeddedMcpControlClient implements McpControlClient {
  readonly configured = true;

  constructor(private readonly transport: McpControlTransport) {}

  private async call<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    let response: { readonly status: number; readonly text: string };
    try {
      response = await this.transport(method, path, body);
    } catch {
      throw new McpControlUnavailableError(
        'unreachable',
        'The MCP integration did not respond. Check the server logs.',
      );
    }
    let json: unknown = undefined;
    if (response.text.length > 0) {
      try {
        json = JSON.parse(response.text);
      } catch {
        throw new McpControlUnavailableError(
          'protocol',
          'The MCP integration returned a response that was not JSON.',
        );
      }
    }
    if (response.status < 200 || response.status >= 300) {
      const envelope = ApiErrorEnvelopeSchema.safeParse(json);
      if (envelope.success) {
        throw new McpControlRequestError(
          response.status,
          envelope.data.error.code,
          envelope.data.error.message,
          envelope.data.error.details,
        );
      }
      throw new McpControlUnavailableError(
        'protocol',
        `The MCP integration returned HTTP ${response.status}.`,
      );
    }
    if (response.status === 204) return undefined as T;
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new McpControlUnavailableError(
        'protocol',
        'The MCP integration response did not match the expected contract.',
      );
    }
    return parsed.data;
  }

  private static actorBody(actor: McpControlActor) {
    return { actor: actor.actor, ...(actor.reason !== undefined ? { reason: actor.reason } : {}) };
  }

  status() {
    return this.call('GET', '/status', McpServiceStatusSchema);
  }
  getSettings() {
    return this.call('GET', '/settings', McpSettingsResponseSchema);
  }
  patchSettings(actor: string, patch: Parameters<McpControlClient['patchSettings']>[1]) {
    return this.call('PATCH', '/settings', McpSettingsResponseSchema, { actor, patch });
  }
  discoveryCheck() {
    return this.call('POST', '/discovery-check', McpDiscoveryCheckResponseSchema, {});
  }
  listConnections(query: McpConnectionListQuery) {
    const params = new URLSearchParams();
    if (query.search !== undefined && query.search.length > 0) params.set('search', query.search);
    if (query.status !== undefined) params.set('status', query.status);
    if (query.mailbox !== undefined && query.mailbox.length > 0)
      params.set('mailbox', query.mailbox);
    const qs = params.toString();
    return this.call(
      'GET',
      `/connections${qs.length > 0 ? `?${qs}` : ''}`,
      McpConnectionListResponseSchema,
    );
  }
  createConnection(request: Parameters<McpControlClient['createConnection']>[0]) {
    return this.call('POST', '/connections', CreateMcpConnectionResponseSchema, request);
  }
  getConnection(id: string) {
    return this.call(
      'GET',
      `/connections/${encodeURIComponent(id)}`,
      McpConnectionDetailResponseSchema,
    );
  }
  updateConnection(id: string, request: Parameters<McpControlClient['updateConnection']>[1]) {
    return this.call(
      'PATCH',
      `/connections/${encodeURIComponent(id)}`,
      McpConnectionDetailResponseSchema,
      request,
    );
  }
  updateCredentials(id: string, request: Parameters<McpControlClient['updateCredentials']>[1]) {
    return this.call(
      'POST',
      `/connections/${encodeURIComponent(id)}/credentials`,
      McpConnectionDetailResponseSchema,
      request,
    );
  }
  reissue(id: string, actor: McpControlActor) {
    return this.call(
      'POST',
      `/connections/${encodeURIComponent(id)}/reissue`,
      McpCredentialIssueResponseSchema,
      EmbeddedMcpControlClient.actorBody(actor),
    );
  }
  rotate(id: string, actor: McpControlActor) {
    return this.call(
      'POST',
      `/connections/${encodeURIComponent(id)}/rotate`,
      McpCredentialIssueResponseSchema,
      EmbeddedMcpControlClient.actorBody(actor),
    );
  }
  test(id: string, actor: McpControlActor) {
    return this.call(
      'POST',
      `/connections/${encodeURIComponent(id)}/test`,
      McpConnectionTestResponseSchema,
      EmbeddedMcpControlClient.actorBody(actor),
    );
  }
  disable(id: string, actor: McpControlActor) {
    return this.call(
      'POST',
      `/connections/${encodeURIComponent(id)}/disable`,
      McpConnectionDetailResponseSchema,
      EmbeddedMcpControlClient.actorBody(actor),
    );
  }
  enable(id: string, actor: McpControlActor) {
    return this.call(
      'POST',
      `/connections/${encodeURIComponent(id)}/enable`,
      McpConnectionDetailResponseSchema,
      EmbeddedMcpControlClient.actorBody(actor),
    );
  }
  revoke(id: string, actor: McpControlActor) {
    return this.call(
      'POST',
      `/connections/${encodeURIComponent(id)}/revoke`,
      McpConnectionDetailResponseSchema,
      EmbeddedMcpControlClient.actorBody(actor),
    );
  }
  async deleteConnection(id: string, actor: McpControlActor) {
    await this.call(
      'POST',
      `/connections/${encodeURIComponent(id)}/delete`,
      z.unknown(),
      EmbeddedMcpControlClient.actorBody(actor),
    );
  }
  revokeGrant(id: string, grantId: string, actor: McpControlActor) {
    return this.call(
      'POST',
      `/connections/${encodeURIComponent(id)}/grants/${encodeURIComponent(grantId)}/revoke`,
      McpConnectionDetailResponseSchema,
      EmbeddedMcpControlClient.actorBody(actor),
    );
  }
  connectionAudit(id: string) {
    return this.call(
      'GET',
      `/connections/${encodeURIComponent(id)}/audit`,
      McpAuditListResponseSchema,
    );
  }
  audit() {
    return this.call('GET', '/audit', McpAuditListResponseSchema);
  }
  mailboxOverview(mailbox: string) {
    return this.call(
      'GET',
      `/mailboxes/${encodeURIComponent(mailbox)}`,
      McpMailboxOverviewResponseSchema,
    );
  }
  reconcile(request: Parameters<McpControlClient['reconcile']>[0]) {
    return this.call('POST', '/mailboxes/reconcile', McpControlReconcileResponseSchema, request);
  }
  mailboxEvent(request: Parameters<McpControlClient['mailboxEvent']>[0]) {
    return this.call('POST', '/mailboxes/events', McpControlMailboxEventResponseSchema, request);
  }
}

/** Used when MCP_ENABLED is off: every call reports "not enabled". */
export class NotConfiguredMcpControlClient implements McpControlClient {
  readonly configured = false;
  private fail(): never {
    throw new McpControlUnavailableError(
      'not_configured',
      'The MCP integration is turned off on this install. Turn on "MCP integration" in Maintenance → Configuration and restart the panel.',
    );
  }
  status = async () => this.fail();
  getSettings = async () => this.fail();
  patchSettings = async () => this.fail();
  discoveryCheck = async () => this.fail();
  listConnections = async () => this.fail();
  createConnection = async () => this.fail();
  getConnection = async () => this.fail();
  updateConnection = async () => this.fail();
  updateCredentials = async () => this.fail();
  reissue = async () => this.fail();
  rotate = async () => this.fail();
  test = async () => this.fail();
  disable = async () => this.fail();
  enable = async () => this.fail();
  revoke = async () => this.fail();
  deleteConnection = async () => this.fail();
  revokeGrant = async () => this.fail();
  connectionAudit = async () => this.fail();
  audit = async () => this.fail();
  mailboxOverview = async () => this.fail();
  reconcile = async () => this.fail();
  mailboxEvent = async () => this.fail();
}
