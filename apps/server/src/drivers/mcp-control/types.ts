/**
 * Port to the embedded MCP integration's control API
 * (docs/mcp-integration.md). An interface with an in-process implementation
 * (`EmbeddedMcpControlClient`, used when MCP_ENABLED is on), a
 * not-enabled stub, and a test double — selected in index.ts / app.ts.
 *
 * Every request and response is one of the `@dwg/shared` MCP contracts —
 * nothing here can carry a raw mailbox credential *back* from apps/mcp,
 * because no response schema has a field for one.
 */
import type {
  CreateMcpConnectionResponse,
  ErrorCode,
  McpAuditListResponse,
  McpConnectionDetailResponse,
  McpConnectionListQuery,
  McpConnectionListResponse,
  McpConnectionTestResponse,
  McpControlCreateConnectionRequest,
  McpControlMailboxEventRequest,
  McpControlReconcileRequest,
  McpControlReconcileResponse,
  McpControlUpdateConnectionRequest,
  McpControlUpdateCredentialsRequest,
  McpCredentialIssueResponse,
  McpDiscoveryCheckResponse,
  McpMailboxOverviewResponse,
  McpServiceStatus,
  McpSettingsPatch,
  McpSettingsResponse,
} from '@dwg/shared';

/** apps/mcp answered with an error envelope — carries its (already user-safe) code and message. */
export class McpControlRequestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    message: string,
    readonly details: unknown,
  ) {
    super(message);
    this.name = 'McpControlRequestError';
  }
}

/** The MCP integration is not enabled, or did not answer as expected. */
export class McpControlUnavailableError extends Error {
  constructor(
    readonly reason: 'not_configured' | 'unreachable' | 'protocol',
    message: string,
  ) {
    super(message);
    this.name = 'McpControlUnavailableError';
  }
}

export interface McpControlActor {
  readonly actor: string;
  readonly reason?: string | undefined;
}

export interface McpControlClient {
  readonly configured: boolean;
  status(): Promise<McpServiceStatus>;
  getSettings(): Promise<McpSettingsResponse>;
  patchSettings(actor: string, patch: McpSettingsPatch): Promise<McpSettingsResponse>;
  discoveryCheck(): Promise<McpDiscoveryCheckResponse>;
  listConnections(query: McpConnectionListQuery): Promise<McpConnectionListResponse>;
  createConnection(
    request: McpControlCreateConnectionRequest,
  ): Promise<CreateMcpConnectionResponse>;
  getConnection(id: string): Promise<McpConnectionDetailResponse>;
  updateConnection(
    id: string,
    request: McpControlUpdateConnectionRequest,
  ): Promise<McpConnectionDetailResponse>;
  updateCredentials(
    id: string,
    request: McpControlUpdateCredentialsRequest,
  ): Promise<McpConnectionDetailResponse>;
  reissue(id: string, actor: McpControlActor): Promise<McpCredentialIssueResponse>;
  rotate(id: string, actor: McpControlActor): Promise<McpCredentialIssueResponse>;
  test(id: string, actor: McpControlActor): Promise<McpConnectionTestResponse>;
  disable(id: string, actor: McpControlActor): Promise<McpConnectionDetailResponse>;
  enable(id: string, actor: McpControlActor): Promise<McpConnectionDetailResponse>;
  revoke(id: string, actor: McpControlActor): Promise<McpConnectionDetailResponse>;
  deleteConnection(id: string, actor: McpControlActor): Promise<void>;
  revokeGrant(
    id: string,
    grantId: string,
    actor: McpControlActor,
  ): Promise<McpConnectionDetailResponse>;
  connectionAudit(id: string): Promise<McpAuditListResponse>;
  audit(): Promise<McpAuditListResponse>;
  mailboxOverview(mailbox: string): Promise<McpMailboxOverviewResponse>;
  reconcile(request: McpControlReconcileRequest): Promise<McpControlReconcileResponse>;
  mailboxEvent(request: McpControlMailboxEventRequest): Promise<{ affectedConnections: number }>;
}
