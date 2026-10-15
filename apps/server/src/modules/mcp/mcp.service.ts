/**
 * Postmaster-side MCP management in the admin tier
 * (docs/mcp-integration.md). This service never holds MCP state itself —
 * apps/mcp owns that, in its own database — it adds the two things only the
 * admin tier can supply:
 *
 *  1. **Mailbox identity.** It confirms the mailbox exists in
 *     docker-mailserver and computes its identity fingerprint: a SHA-256 of
 *     the mailbox's `postfix-accounts.cf` hash line (domain-separated). The
 *     DMS hash is salted, so the fingerprint changes on every password change
 *     *and* on delete-and-recreate — even when done outside the panel — while
 *     revealing nothing usable about the password. apps/mcp compares it on
 *     every create, re-provision and reconciliation.
 *  2. **Lifecycle signals.** Password changes and deletions made through the
 *     panel are pushed to apps/mcp immediately; a periodic reconciliation
 *     catches everything else.
 */
import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import {
  type CreateMcpConnectionRequest,
  type McpStatusResponse,
  type UpdateMcpConnectionRequest,
} from '@dwg/shared';
import type { DmsDriver } from '../../drivers/dms/index.js';
import { AppError } from '../../platform/errors.js';
import {
  McpControlUnavailableError,
  type McpControlClient,
} from '../../drivers/mcp-control/index.js';

export function mailboxIdentityFingerprint(email: string, passwordHash: string): string {
  return createHash('sha256')
    .update('dwg-mcp-mailbox-identity:v1\u0000')
    .update(email.toLowerCase())
    .update('\u0000')
    .update(passwordHash)
    .digest('hex');
}

export class McpService {
  constructor(
    private readonly control: McpControlClient,
    private readonly dms: DmsDriver,
    private readonly logger: Logger,
  ) {}

  get configured(): boolean {
    return this.control.configured;
  }

  /** Current identity fingerprint of a mailbox, or NOT_FOUND. */
  async fingerprintOf(email: string): Promise<{ email: string; fingerprint: string }> {
    const { entries } = await this.dms.listMailboxes();
    const needle = email.toLowerCase();
    const entry = entries.find((candidate) => candidate.email.toLowerCase() === needle);
    if (entry === undefined) {
      throw new AppError('NOT_FOUND', `No mailbox exists for ${email}.`);
    }
    return {
      email: entry.email.toLowerCase(),
      fingerprint: mailboxIdentityFingerprint(entry.email, entry.passwordHash),
    };
  }

  async status(): Promise<McpStatusResponse> {
    try {
      const service = await this.control.status();
      return { deployed: true, reason: null, service };
    } catch (err) {
      if (err instanceof McpControlUnavailableError) {
        return { deployed: false, reason: err.message, service: null };
      }
      throw err;
    }
  }

  async create(actor: string, request: CreateMcpConnectionRequest) {
    const identity = await this.fingerprintOf(request.mailbox);
    return this.control.createConnection({
      mailbox: identity.email,
      mailboxFingerprint: identity.fingerprint,
      label: request.label,
      permissions: request.permissions,
      ...(request.expiresInDays !== undefined ? { expiresInDays: request.expiresInDays } : {}),
      ...(request.mailboxPassword !== undefined
        ? { mailboxPassword: request.mailboxPassword }
        : {}),
      actor,
    });
  }

  /**
   * Additional `From:` identities are accepted only if each is the mailbox
   * itself or an alias that delivers to it — so a connection can never be
   * configured to send as an unrelated address.
   */
  async verifySenderIdentities(mailbox: string, identities: readonly string[]): Promise<string[]> {
    if (identities.length === 0) return [];
    const { entries } = await this.dms.listAliases();
    const target = mailbox.toLowerCase();
    const verified: string[] = [];
    for (const identity of identities) {
      const lower = identity.toLowerCase();
      if (lower === target) continue; // the mailbox itself is always allowed; no need to list it
      const alias = entries.find(
        (entry) => !entry.isCatchAll && entry.address.toLowerCase() === lower,
      );
      if (
        alias === undefined ||
        !alias.recipients.some((recipient) => recipient.toLowerCase() === target)
      ) {
        throw new AppError(
          'VALIDATION_FAILED',
          `${identity} is not an alias that delivers to ${mailbox}.`,
          {
            details: [
              { path: 'senderIdentities', message: `${identity} is not an alias of this mailbox` },
            ],
          },
        );
      }
      if (!verified.includes(lower)) verified.push(lower);
    }
    return verified;
  }

  async update(actor: string, id: string, request: UpdateMcpConnectionRequest) {
    let senderIdentities: string[] | undefined;
    if (request.senderIdentities !== undefined) {
      const { connection } = await this.control.getConnection(id);
      senderIdentities = await this.verifySenderIdentities(
        connection.mailbox,
        request.senderIdentities,
      );
    }
    return this.control.updateConnection(id, {
      actor,
      ...(request.label !== undefined ? { label: request.label } : {}),
      ...(request.permissions !== undefined ? { permissions: request.permissions } : {}),
      ...(request.expiresAt !== undefined ? { expiresAt: request.expiresAt } : {}),
      ...(senderIdentities !== undefined ? { senderIdentities } : {}),
    });
  }

  async updateCredentials(actor: string, id: string, mailboxPassword: string) {
    const { connection } = await this.control.getConnection(id);
    const identity = await this.fingerprintOf(connection.mailbox);
    return this.control.updateCredentials(id, {
      actor,
      mailboxPassword,
      mailboxFingerprint: identity.fingerprint,
    });
  }

  /**
   * Pushes a panel-side mailbox change to apps/mcp. Never fails the caller:
   * the mailbox change has already happened in docker-mailserver, and the
   * periodic reconciliation (plus apps/mcp's own IMAP authentication check)
   * catches up if apps/mcp is unreachable right now.
   */
  async notifyMailboxChange(
    email: string,
    event: 'password_changed' | 'deleted',
    actor: string,
  ): Promise<void> {
    if (!this.control.configured) return;
    try {
      const result = await this.control.mailboxEvent({
        mailbox: email.toLowerCase(),
        event,
        actor,
      });
      if (result.affectedConnections > 0) {
        this.logger.info(
          { event, affectedConnections: result.affectedConnections },
          'MCP connections updated for mailbox change',
        );
      }
    } catch (err) {
      this.logger.warn(
        { event, reason: err instanceof Error ? err.message : 'unknown' },
        'Could not notify the MCP service of a mailbox change; the next reconciliation will apply it',
      );
    }
  }

  /** Sends the full current mailbox list to apps/mcp. Skipped entirely if the list cannot be read. */
  async reconcile(): Promise<void> {
    if (!this.control.configured) return;
    let entries;
    try {
      entries = (await this.dms.listMailboxes()).entries;
    } catch (err) {
      this.logger.warn(
        { reason: err instanceof Error ? err.message : 'unknown' },
        'MCP reconciliation skipped: mailbox list unreadable',
      );
      return;
    }
    try {
      const result = await this.control.reconcile({
        mailboxes: entries.map((entry) => ({
          mailbox: entry.email.toLowerCase(),
          fingerprint: mailboxIdentityFingerprint(entry.email, entry.passwordHash),
        })),
      });
      if (result.stale + result.missing + result.restored > 0) {
        this.logger.info(result, 'MCP reconciliation applied mailbox changes');
      }
    } catch (err) {
      this.logger.debug(
        { reason: err instanceof Error ? err.message : 'unknown' },
        'MCP reconciliation could not reach the MCP service',
      );
    }
  }
}

export interface McpReconcilerHandle {
  stop(): void;
}

const DEFAULT_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

/** Periodic reconciliation; `.unref()`d so it never keeps a process (or a test) alive. */
export function startMcpReconciler(
  service: McpService,
  intervalMs: number = DEFAULT_RECONCILE_INTERVAL_MS,
): McpReconcilerHandle {
  if (!service.configured) return { stop: () => undefined };
  const tick = () => void service.reconcile();
  const first = setTimeout(tick, Math.min(30_000, intervalMs));
  first.unref();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return {
    stop: () => {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}
