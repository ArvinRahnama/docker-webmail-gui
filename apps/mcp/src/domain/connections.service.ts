/**
 * Postmaster-side connection management and mailbox-identity lifecycle.
 * Every method here is reached only through the authenticated control API
 * (control/control.routes.ts), which apps/server calls on behalf of a
 * postmaster holding `mcp:manage`.
 *
 * Status is always *derived* (never stored or invented): see
 * {@link ConnectionsService.statusOf}.
 */
import type {
  McpConnectionDetail,
  McpConnectionStatus,
  McpConnectionSummary,
  McpConnectionTestResult,
  McpControlCreateConnectionRequest,
  McpControlUpdateConnectionRequest,
  McpCredentialHealth,
  McpEnrollmentSummary,
  McpOneTimeCredential,
  McpReconcileEntrySchema,
  McpScope,
  McpStatusCounts,
} from '@dwg/shared';
import type { z } from 'zod';
import type { Database } from '../platform/db.js';
import type { Clock } from '../platform/clock.js';
import { addSeconds } from '../platform/clock.js';
import { ControlError } from '../platform/errors.js';
import {
  generateConnectionId,
  generateEnrollmentUsername,
  generateSetupPassword,
} from '../crypto/random.js';
import { hashSecret } from '../crypto/password-hash.js';
import { CredentialVault, VaultUnavailableError } from '../crypto/vault.js';
import type { BindingRow, BindingsRepository } from '../store/bindings.repository.js';
import type {
  ConnectionRow,
  ConnectionsRepository,
  EnrollmentRow,
} from '../store/connections.repository.js';
import type { OAuthRepository } from '../store/oauth.repository.js';
import type { SettingsRepository } from '../store/settings.repository.js';
import type { McpAuditLog } from './audit.js';
import type { MailBackend, MailAccountContext, VerifyResult } from '../mail/types.js';

export interface ConnectionsServiceDeps {
  readonly db: Database;
  readonly bindings: BindingsRepository;
  readonly connections: ConnectionsRepository;
  readonly oauth: OAuthRepository;
  readonly settings: SettingsRepository;
  readonly vault: CredentialVault;
  readonly mail: MailBackend;
  readonly audit: McpAuditLog;
  readonly clock: Clock;
}

type ReconcileEntry = z.infer<typeof McpReconcileEntrySchema>;

export class ConnectionsService {
  constructor(private readonly deps: ConnectionsServiceDeps) {}

  private nowIso(): string {
    return this.deps.clock.now().toISOString();
  }

  // ---------------------------------------------------------------------------
  // Derivation
  // ---------------------------------------------------------------------------

  mcpUrlFor(connectionId: string): string | null {
    const base = this.deps.settings.get().publicBaseUrl;
    return base === null ? null : `${base}/mcp/${connectionId}`;
  }

  credentialHealthOf(binding: BindingRow): McpCredentialHealth {
    return this.deps.bindings.credentialHealth(binding, this.deps.vault.keyId);
  }

  statusOf(
    connection: ConnectionRow,
    binding: BindingRow,
  ): { status: McpConnectionStatus; reason: string | null } {
    const now = this.deps.clock.now().toISOString();
    if (connection.state === 'revoked') {
      return { status: 'revoked', reason: connection.stateReason ?? 'Revoked by the postmaster.' };
    }
    if (binding.state === 'revoked') {
      return { status: 'revoked', reason: 'The mailbox was deleted.' };
    }
    if (connection.expiresAt !== null && connection.expiresAt <= now) {
      return { status: 'expired', reason: 'The connection lifetime has elapsed.' };
    }
    if (connection.state === 'disabled') {
      return {
        status: 'disabled',
        reason: connection.stateReason ?? 'Disabled by the postmaster.',
      };
    }
    const health = this.credentialHealthOf(binding);
    if (health !== 'healthy') {
      return { status: 'suspended', reason: suspensionReason(health) };
    }
    if (this.deps.oauth.countActiveGrants(connection.id) > 0) {
      return { status: 'active', reason: null };
    }
    return { status: 'pending', reason: 'Awaiting authorization by the mailbox owner.' };
  }

  enrollmentSummary(enrollment: EnrollmentRow | undefined): McpEnrollmentSummary {
    if (enrollment === undefined) {
      return {
        username: null,
        state: 'none',
        issuedAt: null,
        expiresAt: null,
        consumedAt: null,
        failedAttempts: 0,
      };
    }
    const now = this.nowIso();
    const state =
      enrollment.revokedAt !== null
        ? 'revoked'
        : enrollment.consumedAt !== null
          ? 'consumed'
          : enrollment.lockedAt !== null
            ? 'locked'
            : enrollment.expiresAt <= now
              ? 'expired'
              : 'active';
    return {
      username: enrollment.username,
      state,
      issuedAt: enrollment.issuedAt,
      expiresAt: enrollment.expiresAt,
      consumedAt: enrollment.consumedAt,
      failedAttempts: enrollment.failedAttempts,
    };
  }

  private requireBinding(connection: ConnectionRow): BindingRow {
    const binding = this.deps.bindings.findById(connection.bindingId);
    if (binding === undefined) {
      throw new ControlError('INTERNAL', 'Connection references a missing mailbox binding.');
    }
    return binding;
  }

  toSummary(connection: ConnectionRow): McpConnectionSummary {
    const binding = this.requireBinding(connection);
    const { status, reason } = this.statusOf(connection, binding);
    return {
      id: connection.id,
      label: connection.label,
      mailbox: connection.mailbox,
      mcpUrl: this.mcpUrlFor(connection.id),
      permissions: [...connection.scopes],
      status,
      statusReason: reason,
      enrollment: this.enrollmentSummary(this.deps.connections.currentEnrollment(connection.id)),
      credentialHealth: this.credentialHealthOf(binding),
      senderIdentities: [...connection.senderIdentities],
      activeGrantCount: this.deps.oauth.countActiveGrants(connection.id),
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
      expiresAt: connection.expiresAt,
      lastAuthorizedAt: connection.lastAuthorizedAt,
      lastUsedAt: connection.lastUsedAt,
    };
  }

  toDetail(connection: ConnectionRow): McpConnectionDetail {
    const binding = this.requireBinding(connection);
    const credential = this.deps.bindings.getCredential(binding.id);
    return {
      ...this.toSummary(connection),
      grants: this.deps.oauth.listGrants(connection.id).map((grant) => ({
        id: grant.id,
        clientId: grant.clientId,
        clientName: grant.clientName,
        redirectHost: safeHost(grant.redirectUri),
        scopes: [...grant.scopes],
        createdAt: grant.createdAt,
        lastUsedAt: grant.lastUsedAt,
        revokedAt: grant.revokedAt,
        revokedReason: grant.revokedReason,
      })),
      binding: {
        mailbox: binding.mailbox,
        credentialHealth: this.credentialHealthOf(binding),
        credentialProvisionedAt: credential?.createdAt ?? null,
        lastVerifiedAt: binding.lastVerifiedAt,
        lastError: binding.lastError,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  list(filter: {
    search?: string | undefined;
    status?: McpConnectionStatus | undefined;
    mailbox?: string | undefined;
  }): McpConnectionSummary[] {
    const search = filter.search?.toLowerCase();
    const mailbox = filter.mailbox?.toLowerCase();
    return this.deps.connections
      .listAll()
      .map((connection) => this.toSummary(connection))
      .filter((summary) => {
        if (mailbox !== undefined && mailbox.length > 0 && summary.mailbox !== mailbox)
          return false;
        if (filter.status !== undefined && summary.status !== filter.status) return false;
        if (search !== undefined && search.length > 0) {
          return (
            summary.mailbox.includes(search) ||
            summary.label.toLowerCase().includes(search) ||
            summary.id.includes(search)
          );
        }
        return true;
      });
  }

  get(id: string): McpConnectionDetail {
    return this.toDetail(this.requireConnection(id));
  }

  counts(): McpStatusCounts {
    const counts: McpStatusCounts = {
      total: 0,
      pending: 0,
      active: 0,
      disabled: 0,
      suspended: 0,
      expired: 0,
      revoked: 0,
    };
    for (const summary of this.list({})) {
      counts.total += 1;
      counts[summary.status] += 1;
    }
    return counts;
  }

  mailboxOverview(mailbox: string) {
    const binding = this.deps.bindings.findLiveByMailbox(mailbox);
    const connections = this.deps.connections.listByMailbox(mailbox).map((c) => this.toSummary(c));
    if (binding === undefined) return { binding: null, connections };
    const credential = this.deps.bindings.getCredential(binding.id);
    return {
      binding: {
        mailbox: binding.mailbox,
        credentialHealth: this.credentialHealthOf(binding),
        credentialProvisionedAt: credential?.createdAt ?? null,
        lastVerifiedAt: binding.lastVerifiedAt,
        lastError: binding.lastError,
      },
      connections,
    };
  }

  private requireConnection(id: string): ConnectionRow {
    const connection = this.deps.connections.findById(id);
    if (connection === undefined) throw new ControlError('NOT_FOUND', 'No such MCP connection.');
    return connection;
  }

  // ---------------------------------------------------------------------------
  // Credential provisioning
  // ---------------------------------------------------------------------------

  /**
   * Verifies a mailbox password against the real mail server (IMAP login +
   * SMTP AUTH) and, only if both succeed, seals it into the vault. Nothing
   * is stored for a password the mail server rejects.
   */
  private async provisionCredential(
    binding: BindingRow,
    password: string,
    actor: string,
  ): Promise<void> {
    if (!this.deps.vault.available) {
      throw new ControlError(
        'CAPABILITY_UNSUPPORTED',
        'The MCP credential vault key is not configured, so mailbox credentials cannot be stored. See docs/mcp-integration.md.',
      );
    }
    const settings = this.deps.settings.get();
    const account: MailAccountContext = {
      address: binding.mailbox,
      password,
      transport: settings.mail,
    };
    const result = await this.deps.mail.verify(account);
    if (!result.imap.ok || !result.smtp.ok) {
      this.deps.audit.record({
        event: 'binding.verification_failed',
        result: 'failure',
        actor,
        mailbox: binding.mailbox,
        details: { imapOk: result.imap.ok, smtpOk: result.smtp.ok },
      });
      if (result.imap.authFailed || result.smtp.authFailed) {
        throw new ControlError(
          'VALIDATION_FAILED',
          // docker-mailserver applies account changes asynchronously (measured
          // at ~5 s), so a password changed a moment ago is often still
          // rejected. Say so rather than leave the postmaster guessing.
          'The mail server rejected this mailbox password. Nothing was stored. If the password was changed just now, the mail server can take a few seconds to apply it — try again shortly.',
          { details: { imap: result.imap.message, smtp: result.smtp.message } },
        );
      }
      throw new ControlError('UPSTREAM_UNAVAILABLE', describeVerificationFailure(result), {
        details: { imap: result.imap.message, smtp: result.smtp.message },
      });
    }
    const now = this.nowIso();
    const sealed = this.deps.vault.seal(password, binding.id, binding.mailbox);
    this.deps.bindings.putCredential(binding.id, sealed, now);
    this.deps.bindings.markVerified(binding.id, now);
    this.deps.audit.record({
      event: 'binding.provisioned',
      result: 'success',
      actor,
      mailbox: binding.mailbox,
      details: { imapFolders: result.imap.folderCount },
    });
  }

  /** Decrypts the binding's transport credential for an MCP request. Fails closed. */
  openCredential(binding: BindingRow): string {
    const stored = this.deps.bindings.getCredential(binding.id);
    if (stored === undefined) throw new VaultUnavailableError('missing_key');
    return this.deps.vault.open(stored, binding.id, binding.mailbox);
  }

  /**
   * Gets (or creates) the live binding for a mailbox, reconciling it with
   * the identity fingerprint apps/server just read from docker-mailserver.
   * A changed fingerprint means a changed password or a recreated mailbox:
   * the old credential and every grant are invalidated before re-anchoring.
   */
  private resolveBinding(mailbox: string, fingerprint: string, actor: string): BindingRow {
    const now = this.nowIso();
    const existing = this.deps.bindings.findLiveByMailbox(mailbox);
    if (existing === undefined) {
      return this.deps.bindings.create(mailbox, fingerprint, now);
    }
    if (existing.fingerprint !== fingerprint) {
      this.invalidateBinding(existing, 'stale', 'The mailbox password or identity changed.', actor);
      this.deps.bindings.reanchor(existing.id, fingerprint, now);
    } else if (existing.state === 'mailbox_missing') {
      this.deps.bindings.setState(existing.id, 'active', null, now);
    }
    const refreshed = this.deps.bindings.findById(existing.id);
    if (refreshed === undefined)
      throw new ControlError('INTERNAL', 'Binding vanished during resolution.');
    return refreshed;
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  async create(
    request: McpControlCreateConnectionRequest,
  ): Promise<{ connection: McpConnectionDetail; oneTimeCredential: McpOneTimeCredential }> {
    const settings = this.deps.settings.get();
    if (!settings.enabled) {
      throw new ControlError(
        'CONFLICT',
        'MCP is disabled. Enable it in the MCP settings before generating connections.',
      );
    }
    if (settings.publicBaseUrl === null) {
      throw new ControlError(
        'CONFLICT',
        'Set the public MCP endpoint URL before generating connections.',
      );
    }
    const actor = `postmaster:${request.actor}`;
    const binding = this.resolveBinding(request.mailbox, request.mailboxFingerprint, actor);

    if (
      this.deps.connections.countNonRevokedForBinding(binding.id) >=
      settings.maxConnectionsPerMailbox
    ) {
      throw new ControlError(
        'CONFLICT',
        `This mailbox already has the maximum of ${settings.maxConnectionsPerMailbox} connections. Revoke or delete one first.`,
      );
    }

    if (request.mailboxPassword !== undefined) {
      await this.provisionCredential(binding, request.mailboxPassword, actor);
    }
    const bindingAfter = this.deps.bindings.findById(binding.id) ?? binding;
    if (this.credentialHealthOf(bindingAfter) !== 'healthy') {
      throw new ControlError(
        'VALIDATION_FAILED',
        'This mailbox has no usable IMAP/SMTP credential. Provide the mailbox password so it can be verified and stored.',
        { details: [{ path: 'mailboxPassword', message: 'required for this mailbox' }] },
      );
    }

    const now = this.deps.clock.now();
    const expiresInDays =
      request.expiresInDays === undefined ? settings.connectionExpiryDays : request.expiresInDays;
    const id = generateConnectionId();
    const connection = this.deps.connections.create({
      id,
      bindingId: binding.id,
      mailbox: binding.mailbox,
      label: request.label,
      scopes: request.permissions,
      senderIdentities: [],
      createdBy: actor,
      expiresAt:
        expiresInDays === null ? null : addSeconds(now, expiresInDays * 86_400).toISOString(),
      nowIso: now.toISOString(),
    });
    this.deps.audit.record({
      event: 'connection.created',
      result: 'success',
      actor,
      connectionId: connection.id,
      mailbox: connection.mailbox,
      details: { scopes: request.permissions.join(' '), expiresAt: connection.expiresAt },
    });
    const oneTimeCredential = await this.issueEnrollment(
      connection,
      actor,
      'enrollment.issued',
      true,
    );
    return { connection: this.toDetail(connection), oneTimeCredential };
  }

  /**
   * Generates a fresh username (when `newUsername`) and setup password,
   * storing only the Argon2id hash. Any earlier enrollment for the
   * connection is revoked in the same transaction.
   */
  private async issueEnrollment(
    connection: ConnectionRow,
    actor: string,
    event: 'enrollment.issued' | 'enrollment.reissued' | 'enrollment.rotated',
    newUsername: boolean,
  ): Promise<McpOneTimeCredential> {
    const settings = this.deps.settings.get();
    const previous = this.deps.connections.currentEnrollment(connection.id);
    const username =
      newUsername || previous === undefined ? generateEnrollmentUsername() : previous.username;
    const setupPassword = generateSetupPassword();
    const passwordHash = await hashSecret(setupPassword);
    const now = this.deps.clock.now();
    const expiresAt = addSeconds(now, settings.setupCredentialTtlHours * 3600).toISOString();
    if (!newUsername && previous !== undefined) {
      // Reissue: same username, brand-new secret. Resetting the row in place
      // also clears any reservation, so an authorization code minted against
      // the previous password can no longer be redeemed.
      this.deps.connections.resetEnrollment(
        previous.id,
        passwordHash,
        expiresAt,
        now.toISOString(),
      );
    } else {
      this.deps.connections.issueEnrollment({
        connectionId: connection.id,
        username,
        passwordHash,
        expiresAt,
        nowIso: now.toISOString(),
      });
    }
    this.deps.audit.record({
      event,
      result: 'success',
      actor,
      connectionId: connection.id,
      mailbox: connection.mailbox,
      details: { username, expiresAt },
    });
    return { username, setupPassword, expiresAt };
  }

  private assertMutable(connection: ConnectionRow): void {
    if (connection.state === 'revoked') {
      throw new ControlError(
        'CONFLICT',
        'This connection has been revoked and can no longer be changed.',
      );
    }
  }

  async reissue(
    id: string,
    actorEmail: string,
  ): Promise<{ connection: McpConnectionDetail; oneTimeCredential: McpOneTimeCredential }> {
    const connection = this.requireConnection(id);
    this.assertMutable(connection);
    const binding = this.requireBinding(connection);
    if (binding.state === 'revoked') throw new ControlError('CONFLICT', 'The mailbox was deleted.');
    const oneTimeCredential = await this.issueEnrollment(
      connection,
      `postmaster:${actorEmail}`,
      'enrollment.reissued',
      false,
    );
    return { connection: this.toDetail(this.requireConnection(id)), oneTimeCredential };
  }

  /** New username + password, and every existing grant/token revoked: forces re-authorization. */
  async rotate(
    id: string,
    actorEmail: string,
  ): Promise<{ connection: McpConnectionDetail; oneTimeCredential: McpOneTimeCredential }> {
    const connection = this.requireConnection(id);
    this.assertMutable(connection);
    const actor = `postmaster:${actorEmail}`;
    const revoked = this.deps.oauth.revokeAllGrantsForConnection(
      id,
      'credentials rotated',
      this.nowIso(),
    );
    if (revoked > 0) {
      this.deps.audit.record({
        event: 'oauth.grant_revoked',
        result: 'success',
        actor,
        connectionId: id,
        mailbox: connection.mailbox,
        details: { grants: revoked, reason: 'credentials rotated' },
      });
    }
    const oneTimeCredential = await this.issueEnrollment(
      connection,
      actor,
      'enrollment.rotated',
      true,
    );
    return { connection: this.toDetail(this.requireConnection(id)), oneTimeCredential };
  }

  update(
    id: string,
    request: McpControlUpdateConnectionRequest,
    verifiedSenderIdentities?: readonly string[],
  ): McpConnectionDetail {
    const connection = this.requireConnection(id);
    this.assertMutable(connection);
    this.deps.connections.update(
      id,
      {
        label: request.label,
        scopes: request.permissions,
        senderIdentities: verifiedSenderIdentities ?? request.senderIdentities,
        expiresAt: request.expiresAt,
      },
      this.nowIso(),
    );
    this.deps.audit.record({
      event: 'connection.updated',
      result: 'success',
      actor: `postmaster:${request.actor}`,
      connectionId: id,
      mailbox: connection.mailbox,
      details: {
        scopes: request.permissions?.join(' ') ?? null,
        labelChanged: request.label !== undefined,
        expiryChanged: request.expiresAt !== undefined,
        senderIdentities: request.senderIdentities?.length ?? null,
      },
    });
    return this.get(id);
  }

  async updateCredentials(
    id: string,
    password: string,
    fingerprint: string,
    actorEmail: string,
  ): Promise<McpConnectionDetail> {
    const connection = this.requireConnection(id);
    this.assertMutable(connection);
    const actor = `postmaster:${actorEmail}`;
    const binding = this.resolveBinding(connection.mailbox, fingerprint, actor);
    if (binding.id !== connection.bindingId) {
      throw new ControlError(
        'CONFLICT',
        'This connection belongs to a mailbox that no longer exists.',
      );
    }
    await this.provisionCredential(binding, password, actor);
    if (binding.state !== 'active') {
      this.deps.bindings.setState(binding.id, 'active', null, this.nowIso());
    }
    return this.get(id);
  }

  async test(
    id: string,
    actorEmail: string,
  ): Promise<{ result: McpConnectionTestResult; connection: McpConnectionDetail }> {
    const connection = this.requireConnection(id);
    const binding = this.requireBinding(connection);
    const testedAt = this.nowIso();
    if (this.credentialHealthOf(binding) !== 'healthy') {
      return {
        result: {
          imap: {
            ok: false,
            message: suspensionReason(this.credentialHealthOf(binding)),
            folderCount: null,
          },
          smtp: { ok: false, message: 'Not attempted.' },
          testedAt,
        },
        connection: this.get(id),
      };
    }
    let password: string;
    try {
      password = this.openCredential(binding);
    } catch (err) {
      const message =
        err instanceof VaultUnavailableError
          ? err.message
          : 'The stored credential could not be read.';
      return {
        result: {
          imap: { ok: false, message, folderCount: null },
          smtp: { ok: false, message: 'Not attempted.' },
          testedAt,
        },
        connection: this.get(id),
      };
    }
    const result = await this.deps.mail.verify({
      address: binding.mailbox,
      password,
      transport: this.deps.settings.get().mail,
    });
    const actor = `postmaster:${actorEmail}`;
    if (result.imap.ok && result.smtp.ok) {
      this.deps.bindings.markVerified(binding.id, this.nowIso());
      this.deps.audit.record({
        event: 'binding.verified',
        result: 'success',
        actor,
        connectionId: id,
        mailbox: binding.mailbox,
      });
    } else {
      if (result.imap.authFailed || result.smtp.authFailed) {
        this.markCredentialRejected(binding, actor);
      } else {
        this.deps.bindings.recordError(
          binding.id,
          `${result.imap.message} / ${result.smtp.message}`,
          this.nowIso(),
        );
      }
      this.deps.audit.record({
        event: 'binding.verification_failed',
        result: 'failure',
        actor,
        connectionId: id,
        mailbox: binding.mailbox,
        details: { imapOk: result.imap.ok, smtpOk: result.smtp.ok },
      });
    }
    return {
      result: {
        imap: {
          ok: result.imap.ok,
          message: result.imap.message,
          folderCount: result.imap.folderCount,
        },
        smtp: { ok: result.smtp.ok, message: result.smtp.message },
        testedAt,
      },
      connection: this.get(id),
    };
  }

  disable(id: string, actorEmail: string, reason?: string): McpConnectionDetail {
    const connection = this.requireConnection(id);
    this.assertMutable(connection);
    this.deps.connections.setState(id, 'disabled', reason ?? null, this.nowIso());
    this.deps.audit.record({
      event: 'connection.disabled',
      result: 'success',
      actor: `postmaster:${actorEmail}`,
      connectionId: id,
      mailbox: connection.mailbox,
    });
    return this.get(id);
  }

  enable(id: string, actorEmail: string): McpConnectionDetail {
    const connection = this.requireConnection(id);
    this.assertMutable(connection);
    this.deps.connections.setState(id, 'enabled', null, this.nowIso());
    this.deps.audit.record({
      event: 'connection.enabled',
      result: 'success',
      actor: `postmaster:${actorEmail}`,
      connectionId: id,
      mailbox: connection.mailbox,
    });
    return this.get(id);
  }

  /** Permanent: revokes every grant and token and the setup credential. Cannot be undone. */
  revoke(id: string, actorEmail: string, reason?: string): McpConnectionDetail {
    const connection = this.requireConnection(id);
    if (connection.state === 'revoked') return this.get(id);
    this.revokeConnectionInternal(
      connection,
      `postmaster:${actorEmail}`,
      reason ?? 'Revoked by the postmaster.',
    );
    return this.get(id);
  }

  private revokeConnectionInternal(connection: ConnectionRow, actor: string, reason: string): void {
    const now = this.nowIso();
    this.deps.db.transaction(() => {
      this.deps.oauth.revokeAllGrantsForConnection(connection.id, reason, now);
      this.deps.connections.revokeEnrollments(connection.id, now);
      this.deps.connections.setState(connection.id, 'revoked', reason, now);
    });
    this.deps.audit.record({
      event: 'connection.revoked',
      result: 'success',
      actor,
      connectionId: connection.id,
      mailbox: connection.mailbox,
      details: { reason },
    });
  }

  /** Removes the connection record. The mailbox itself is never touched. */
  delete(id: string, actorEmail: string): void {
    const connection = this.requireConnection(id);
    const actor = `postmaster:${actorEmail}`;
    if (connection.state !== 'revoked') {
      this.revokeConnectionInternal(connection, actor, 'Deleted by the postmaster.');
    }
    this.deps.connections.delete(id);
    this.deps.audit.record({
      event: 'connection.deleted',
      result: 'success',
      actor,
      connectionId: id,
      mailbox: connection.mailbox,
    });
  }

  revokeGrant(connectionId: string, grantId: string, actorEmail: string): McpConnectionDetail {
    const connection = this.requireConnection(connectionId);
    const grant = this.deps.oauth.findGrant(grantId);
    // IDOR guard: the grant must belong to the connection named in the path.
    if (grant === undefined || grant.connectionId !== connection.id) {
      throw new ControlError('NOT_FOUND', 'No such grant on this connection.');
    }
    if (this.deps.oauth.revokeGrant(grant.id, 'Revoked by the postmaster.', this.nowIso())) {
      this.deps.audit.record({
        event: 'oauth.grant_revoked',
        result: 'success',
        actor: `postmaster:${actorEmail}`,
        connectionId,
        mailbox: connection.mailbox,
        details: { grantId: grant.id, clientId: grant.clientId },
      });
    }
    return this.get(connectionId);
  }

  // ---------------------------------------------------------------------------
  // Mailbox identity lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Invalidates a binding whose identity can no longer be trusted: wipes the
   * stored credential and revokes every grant (and so every token) of every
   * connection for that mailbox. Connections stay (suspended) so the
   * postmaster can re-provision and reissue setup credentials.
   */
  private invalidateBinding(
    binding: BindingRow,
    state: 'stale' | 'invalid',
    reason: string,
    actor: string,
  ): number {
    const now = this.nowIso();
    const connections = this.deps.connections.listByBinding(binding.id);
    this.deps.db.transaction(() => {
      this.deps.bindings.deleteCredential(binding.id);
      this.deps.bindings.setState(binding.id, state, reason, now);
      for (const connection of connections) {
        this.deps.oauth.revokeAllGrantsForConnection(connection.id, reason, now);
      }
    });
    this.deps.audit.record({
      event: 'binding.stale',
      result: 'success',
      actor,
      mailbox: binding.mailbox,
      details: { state, connections: connections.length },
    });
    return connections.length;
  }

  /** Called when the mail server rejects the stored credential (AUTHENTICATIONFAILED). */
  markCredentialRejected(binding: BindingRow, actor: string): void {
    this.invalidateBinding(
      binding,
      'invalid',
      'The mail server rejected the stored mailbox credential.',
      actor,
    );
  }

  /** Explicit lifecycle event from apps/server (the panel changed or deleted the mailbox). */
  mailboxEvent(mailbox: string, event: 'password_changed' | 'deleted', actorEmail: string): number {
    const binding = this.deps.bindings.findLiveByMailbox(mailbox);
    if (binding === undefined) return 0;
    const actor = `postmaster:${actorEmail}`;
    if (event === 'password_changed') {
      return this.invalidateBinding(binding, 'stale', 'The mailbox password was changed.', actor);
    }
    // Deleted: everything about this mailbox identity is revoked for good. A
    // mailbox later recreated with the same address gets a new binding.
    const now = this.nowIso();
    const connections = this.deps.connections.listByBinding(binding.id);
    for (const connection of connections) {
      if (connection.state !== 'revoked')
        this.revokeConnectionInternal(connection, actor, 'The mailbox was deleted.');
    }
    this.deps.db.transaction(() => {
      this.deps.bindings.deleteCredential(binding.id);
      this.deps.bindings.setState(binding.id, 'revoked', 'The mailbox was deleted.', now);
    });
    this.deps.audit.record({
      event: 'binding.revoked',
      result: 'success',
      actor,
      mailbox,
      details: { connections: connections.length },
    });
    return connections.length;
  }

  /**
   * Periodic reconciliation against the full mailbox list apps/server read
   * from docker-mailserver. Catches changes made outside the panel.
   */
  reconcile(entries: readonly ReconcileEntry[]): {
    checked: number;
    stale: number;
    missing: number;
    restored: number;
  } {
    const byMailbox = new Map(entries.map((entry) => [entry.mailbox, entry.fingerprint]));
    let stale = 0;
    let missing = 0;
    let restored = 0;
    const live = this.deps.bindings.listLive();
    const now = this.nowIso();
    for (const binding of live) {
      const fingerprint = byMailbox.get(binding.mailbox);
      if (fingerprint === undefined) {
        if (binding.state !== 'mailbox_missing') {
          // Fail closed but reversibly: access is blocked until the mailbox
          // reappears *unchanged*. A transient read glitch must not destroy
          // grants; a real deletion through the panel arrives as an explicit
          // 'deleted' event, and a recreate shows up as a fingerprint change.
          this.deps.bindings.setState(
            binding.id,
            'mailbox_missing',
            'Not present in the last mailbox reconciliation.',
            now,
          );
          this.deps.audit.record({
            event: 'binding.mailbox_missing',
            result: 'success',
            actor: 'system',
            mailbox: binding.mailbox,
          });
          missing += 1;
        }
        continue;
      }
      if (fingerprint !== binding.fingerprint) {
        if (binding.state !== 'stale') {
          this.invalidateBinding(
            binding,
            'stale',
            'The mailbox password or identity changed outside MCP.',
            'system',
          );
          stale += 1;
        }
        continue;
      }
      if (binding.state === 'mailbox_missing') {
        this.deps.bindings.setState(binding.id, 'active', null, now);
        this.deps.audit.record({
          event: 'binding.mailbox_restored',
          result: 'success',
          actor: 'system',
          mailbox: binding.mailbox,
        });
        restored += 1;
      }
    }
    return { checked: live.length, stale, missing, restored };
  }
}

/**
 * The postmaster-facing reason a credential check failed for something other
 * than a rejected password. Built only from the backend's own fixed messages
 * (never server output), and it names the fix for the commonest case: a
 * certificate issued for a public name while the mail host is the container
 * name.
 */
export function describeVerificationFailure(result: VerifyResult): string {
  const failed = [
    ...(result.imap.ok ? [] : [`IMAP: ${result.imap.message}`]),
    ...(result.smtp.ok ? [] : [`SMTP: ${result.smtp.message}`]),
  ];
  const certificate = /certificate/i.test(`${result.imap.message} ${result.smtp.message}`)
    ? ' If the mail server’s certificate is issued for a different name than the mail host (for example a public hostname while the host is the container name), set that name as Certificate name in Service settings.'
    : '';
  return `Could not verify the mailbox password against the mail server. ${failed.join(' ')} Nothing was stored.${certificate}`;
}

function suspensionReason(health: McpCredentialHealth): string {
  switch (health) {
    case 'missing':
      return 'No IMAP/SMTP credential is provisioned for this mailbox.';
    case 'stale':
      return 'The mailbox password changed; the postmaster must re-provision credentials and reissue setup credentials.';
    case 'invalid':
      return 'The mail server rejected the stored credential; the postmaster must re-provision it.';
    case 'mailbox_missing':
      return 'The mailbox was not found in docker-mailserver.';
    case 'revoked':
      return 'The mailbox was deleted.';
    case 'vault_unavailable':
      return 'The credential vault key is missing or does not match.';
    case 'healthy':
      return '';
  }
}

function safeHost(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return 'unknown';
  }
}

export function scopesIntersect(a: readonly McpScope[], b: readonly McpScope[]): McpScope[] {
  return a.filter((scope) => b.includes(scope));
}
