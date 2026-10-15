/**
 * apps/mcp's security/activity trail (`mcp_audit_events`). Mirrors the
 * admin tier's audit rules (apps/server/src/platform/audit.ts): a closed
 * event vocabulary, primitive-only details, and a denylist that refuses to
 * write any detail key that looks like it could carry a secret or message
 * content. Tool calls are recorded by *name and outcome* only — never their
 * arguments, never anything read from or written to a mailbox.
 */
import type { McpAuditEvent } from '@dwg/shared';
import type { Database } from '../platform/db.js';
import { generateRowId } from '../crypto/random.js';

export const MCP_AUDIT_EVENT_NAMES = [
  'settings.updated',
  'connection.created',
  'connection.updated',
  'connection.disabled',
  'connection.enabled',
  'connection.revoked',
  'connection.deleted',
  'enrollment.issued',
  'enrollment.reissued',
  'enrollment.rotated',
  'enrollment.login_failed',
  'enrollment.locked',
  'enrollment.consumed',
  'binding.provisioned',
  'binding.verified',
  'binding.verification_failed',
  'binding.stale',
  'binding.mailbox_missing',
  'binding.mailbox_restored',
  'binding.revoked',
  'oauth.client_registered',
  'oauth.client_metadata_rejected',
  'oauth.authorization_granted',
  'oauth.authorization_denied',
  'oauth.token_issued',
  'oauth.token_refreshed',
  'oauth.refresh_replay_detected',
  'oauth.code_replay_detected',
  'oauth.token_revoked',
  'oauth.grant_revoked',
  'access.denied',
  'tool.called',
  'tool.denied',
  'mail.sent',
  'mail.send_failed',
  'mail.moved_to_trash',
  'mail.restored',
] as const;
export type McpAuditEventName = (typeof MCP_AUDIT_EVENT_NAMES)[number];

export type AuditDetailValue = string | number | boolean | null;
export type AuditDetails = Readonly<Record<string, AuditDetailValue>>;

export interface McpAuditRecord {
  readonly event: McpAuditEventName;
  readonly result: 'success' | 'failure';
  /** `postmaster:<email>`, `client:<client_id>`, `enrollment:<username>`, `system`, or `anonymous`. */
  readonly actor: string;
  readonly connectionId?: string | null | undefined;
  readonly mailbox?: string | null | undefined;
  readonly ip?: string | null | undefined;
  readonly details?: AuditDetails | undefined;
}

const FORBIDDEN_DETAIL_KEY =
  /password|secret|token|hash|cipher|verifier|body|content|subject|text|html|attachment/i;
const MAX_DETAIL_STRING = 200;

export function assertSafeAuditDetails(details: AuditDetails): void {
  for (const key of Object.keys(details)) {
    if (FORBIDDEN_DETAIL_KEY.test(key)) {
      throw new Error(
        `Refusing to write MCP audit event: details key "${key}" could carry a secret or message content.`,
      );
    }
  }
}

function clamp(details: AuditDetails): Record<string, AuditDetailValue> {
  const out: Record<string, AuditDetailValue> = {};
  for (const [key, value] of Object.entries(details)) {
    out[key] =
      typeof value === 'string' && value.length > MAX_DETAIL_STRING
        ? `${value.slice(0, MAX_DETAIL_STRING)}…`
        : value;
  }
  return out;
}

export class McpAuditLog {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  record(entry: McpAuditRecord): void {
    const details = entry.details ?? {};
    assertSafeAuditDetails(details);
    this.db.run(
      `INSERT INTO mcp_audit_events (id, occurred_at, connection_id, mailbox, actor, event, result, ip, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        generateRowId('ae'),
        this.now().toISOString(),
        entry.connectionId ?? null,
        entry.mailbox ?? null,
        entry.actor.slice(0, 254),
        entry.event,
        entry.result,
        entry.ip ?? null,
        JSON.stringify(clamp(details)),
      ],
    );
  }

  list(options: {
    readonly connectionId?: string | undefined;
    readonly failuresOnly?: boolean | undefined;
    readonly limit: number;
  }): McpAuditEvent[] {
    // One static statement with NULL-able filters — no SQL is ever assembled
    // from fragments (SECURITY.md §3.8).
    const connectionId = options.connectionId ?? null;
    const failuresOnly = options.failuresOnly === true ? 1 : 0;
    const limit = Math.min(Math.max(options.limit, 1), 500);
    const rows = this.db.all<{
      id: string;
      occurred_at: string;
      connection_id: string | null;
      mailbox: string | null;
      actor: string;
      event: string;
      result: string;
      ip: string | null;
      details: string;
    }>(
      `SELECT id, occurred_at, connection_id, mailbox, actor, event, result, ip, details
         FROM mcp_audit_events
        WHERE (? IS NULL OR connection_id = ?)
          AND (? = 0 OR result = 'failure')
        ORDER BY occurred_at DESC, id DESC
        LIMIT ?`,
      [connectionId, connectionId, failuresOnly, limit],
    );
    return rows.map((row) => ({
      id: row.id,
      occurredAt: row.occurred_at,
      connectionId: row.connection_id,
      mailbox: row.mailbox,
      actor: row.actor,
      event: row.event,
      result: row.result === 'failure' ? 'failure' : 'success',
      ip: row.ip,
      details: parseDetails(row.details),
    }));
  }

  /** Retention sweep — the only way audit rows are ever removed. */
  purgeOlderThan(cutoffIso: string): number {
    return Number(
      this.db.run('DELETE FROM mcp_audit_events WHERE occurred_at < ?', [cutoffIso]).changes,
    );
  }
}

function parseDetails(raw: string): Record<string, AuditDetailValue> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, AuditDetailValue> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      ) {
        out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}
