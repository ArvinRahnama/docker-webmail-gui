/**
 * In-memory stand-in for apps/mcp's control API, for apps/server's own
 * route tests. It models only what those tests assert (state transitions,
 * call recording, the one-time credential being returned once) — the real
 * OAuth/MCP behaviour is tested in apps/mcp against the real service.
 */
import { randomBytes } from 'node:crypto';
import {
  MCP_SCOPES,
  type CreateMcpConnectionResponse,
  type McpAuditEvent,
  type McpConnectionDetail,
  type McpConnectionListQuery,
  type McpControlCreateConnectionRequest,
  type McpControlMailboxEventRequest,
  type McpControlReconcileRequest,
  type McpControlUpdateConnectionRequest,
  type McpControlUpdateCredentialsRequest,
  type McpServiceStatus,
  type McpSettings,
  type McpSettingsPatch,
} from '@dwg/shared';
import { McpControlRequestError, type McpControlActor, type McpControlClient } from './types.js';

export function defaultFakeMcpSettings(): McpSettings {
  return {
    enabled: false,
    publicBaseUrl: 'https://mcp.example.test',
    mail: {
      imapHost: 'mailserver',
      imapPort: 993,
      imapSecurity: 'tls',
      smtpHost: 'mailserver',
      smtpPort: 465,
      smtpSecurity: 'tls',
      tlsServername: null,
      tlsVerify: true,
    },
    setupCredentialTtlHours: 24,
    connectionExpiryDays: null,
    defaultPermissions: [...MCP_SCOPES],
    maxConnectionsPerMailbox: 5,
    auditRetentionDays: 180,
    accessTokenTtlMinutes: 15,
    refreshTokenTtlDays: 30,
    rateLimits: {
      toolCallsPerMinute: 60,
      sendsPerHour: 20,
      sendsPerDay: 100,
      maxRecipientsPerMessage: 20,
    },
    maxAttachmentBytes: 10 * 1024 * 1024,
    saveSentCopies: true,
    clientRegistration: {
      dynamicRegistration: true,
      metadataDocuments: true,
      allowedMetadataHosts: [],
    },
  };
}

export class FakeMcpControlClient implements McpControlClient {
  readonly configured = true;
  settings: McpSettings = defaultFakeMcpSettings();
  readonly connections = new Map<string, McpConnectionDetail>();
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  readonly events: McpAuditEvent[] = [];
  version = '1.0.2';

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  private require(id: string): McpConnectionDetail {
    const connection = this.connections.get(id);
    if (connection === undefined)
      throw new McpControlRequestError(404, 'NOT_FOUND', 'No such MCP connection.', null);
    return connection;
  }

  private credential() {
    return {
      username: `mcp-${randomBytes(8).toString('hex')}`,
      setupPassword: randomBytes(15).toString('hex').toUpperCase(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
  }

  async status(): Promise<McpServiceStatus> {
    this.record('status');
    const list = [...this.connections.values()];
    const count = (status: string) => list.filter((c) => c.status === status).length;
    return {
      version: this.version,
      controlProtocolVersion: 1,
      uptimeSeconds: 10,
      enabled: this.settings.enabled,
      publicBaseUrl: this.settings.publicBaseUrl,
      issuer: this.settings.publicBaseUrl,
      vault: 'ok',
      mailBackend: 'fake',
      counts: {
        total: list.length,
        pending: count('pending'),
        active: count('active'),
        disabled: count('disabled'),
        suspended: count('suspended'),
        expired: count('expired'),
        revoked: count('revoked'),
      },
      recentEvents: this.events.slice(0, 20),
      recentFailures: [],
    };
  }

  async getSettings() {
    this.record('getSettings');
    return { settings: this.settings, issuer: this.settings.publicBaseUrl, warnings: [] };
  }

  async patchSettings(actor: string, patch: McpSettingsPatch) {
    this.record('patchSettings', actor, patch);
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );
    this.settings = { ...this.settings, ...(defined as Partial<McpSettings>) };
    return { settings: this.settings, issuer: this.settings.publicBaseUrl, warnings: [] };
  }

  async discoveryCheck() {
    this.record('discoveryCheck');
    return {
      checks: [{ check: 'public-url', ok: true, message: 'ok' }],
      checkedAt: new Date().toISOString(),
    };
  }

  async listConnections(query: McpConnectionListQuery) {
    this.record('listConnections', query);
    const connections = [...this.connections.values()].filter(
      (c) =>
        (query.mailbox === undefined || c.mailbox === query.mailbox) &&
        (query.status === undefined || c.status === query.status),
    );
    return { connections };
  }

  async createConnection(
    request: McpControlCreateConnectionRequest,
  ): Promise<CreateMcpConnectionResponse> {
    this.record('createConnection', request);
    if (!this.settings.enabled)
      throw new McpControlRequestError(409, 'CONFLICT', 'MCP is disabled.', null);
    const id = `c${randomBytes(17)
      .toString('hex')
      .slice(0, 26)
      .replace(/[^0-9a-z]/g, 'a')}`;
    const now = new Date().toISOString();
    const oneTimeCredential = this.credential();
    const connection: McpConnectionDetail = {
      id,
      label: request.label,
      mailbox: request.mailbox,
      mcpUrl: `${this.settings.publicBaseUrl}/mcp/${id}`,
      permissions: request.permissions,
      status: 'pending',
      statusReason: 'Awaiting authorization by the mailbox owner.',
      enrollment: {
        username: oneTimeCredential.username,
        state: 'active',
        issuedAt: now,
        expiresAt: oneTimeCredential.expiresAt,
        consumedAt: null,
        failedAttempts: 0,
      },
      credentialHealth: 'healthy',
      senderIdentities: [],
      activeGrantCount: 0,
      createdAt: now,
      updatedAt: now,
      expiresAt: null,
      lastAuthorizedAt: null,
      lastUsedAt: null,
      grants: [],
      binding: {
        mailbox: request.mailbox,
        credentialHealth: 'healthy',
        credentialProvisionedAt: now,
        lastVerifiedAt: now,
        lastError: null,
      },
    };
    this.connections.set(id, connection);
    return { connection, oneTimeCredential };
  }

  async getConnection(id: string) {
    this.record('getConnection', id);
    return { connection: this.require(id) };
  }

  async updateConnection(id: string, request: McpControlUpdateConnectionRequest) {
    this.record('updateConnection', id, request);
    const current = this.require(id);
    const next: McpConnectionDetail = {
      ...current,
      ...(request.label !== undefined ? { label: request.label } : {}),
      ...(request.permissions !== undefined ? { permissions: request.permissions } : {}),
      ...(request.senderIdentities !== undefined
        ? { senderIdentities: request.senderIdentities }
        : {}),
      ...(request.expiresAt !== undefined ? { expiresAt: request.expiresAt } : {}),
    };
    this.connections.set(id, next);
    return { connection: next };
  }

  async updateCredentials(id: string, request: McpControlUpdateCredentialsRequest) {
    this.record('updateCredentials', id, request);
    return { connection: this.require(id) };
  }

  async reissue(id: string, actor: McpControlActor) {
    this.record('reissue', id, actor);
    return { connection: this.require(id), oneTimeCredential: this.credential() };
  }

  async rotate(id: string, actor: McpControlActor) {
    this.record('rotate', id, actor);
    return { connection: this.require(id), oneTimeCredential: this.credential() };
  }

  async test(id: string, actor: McpControlActor) {
    this.record('test', id, actor);
    const now = new Date().toISOString();
    return {
      connection: this.require(id),
      result: {
        imap: { ok: true, message: 'ok', folderCount: 4 },
        smtp: { ok: true, message: 'ok' },
        testedAt: now,
      },
    };
  }

  private setStatus(id: string, status: McpConnectionDetail['status']) {
    const next = { ...this.require(id), status };
    this.connections.set(id, next);
    return { connection: next };
  }

  async disable(id: string, actor: McpControlActor) {
    this.record('disable', id, actor);
    return this.setStatus(id, 'disabled');
  }

  async enable(id: string, actor: McpControlActor) {
    this.record('enable', id, actor);
    return this.setStatus(id, 'pending');
  }

  async revoke(id: string, actor: McpControlActor) {
    this.record('revoke', id, actor);
    return this.setStatus(id, 'revoked');
  }

  async deleteConnection(id: string, actor: McpControlActor) {
    this.record('deleteConnection', id, actor);
    this.require(id);
    this.connections.delete(id);
  }

  async revokeGrant(id: string, grantId: string, actor: McpControlActor) {
    this.record('revokeGrant', id, grantId, actor);
    return { connection: this.require(id) };
  }

  async connectionAudit(id: string) {
    this.record('connectionAudit', id);
    this.require(id);
    return { events: this.events.filter((e) => e.connectionId === id) };
  }

  async audit() {
    this.record('audit');
    return { events: this.events };
  }

  async mailboxOverview(mailbox: string) {
    this.record('mailboxOverview', mailbox);
    const connections = [...this.connections.values()].filter((c) => c.mailbox === mailbox);
    return { binding: connections[0]?.binding ?? null, connections };
  }

  async reconcile(request: McpControlReconcileRequest) {
    this.record('reconcile', request);
    return { checked: request.mailboxes.length, stale: 0, missing: 0, restored: 0 };
  }

  async mailboxEvent(request: McpControlMailboxEventRequest) {
    this.record('mailboxEvent', request);
    let affected = 0;
    for (const connection of this.connections.values()) {
      if (connection.mailbox === request.mailbox) {
        affected += 1;
        this.connections.set(connection.id, {
          ...connection,
          status: request.event === 'deleted' ? 'revoked' : 'suspended',
        });
      }
    }
    return { affectedConnections: affected };
  }
}
