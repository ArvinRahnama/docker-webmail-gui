/**
 * Append-only security audit log (ARCHITECTURE.md §7.6). Every write
 * goes through {@link recordAuditEvent}, which takes a fully-typed,
 * enumerated payload — there is no free-form `details: any` bag a caller
 * could accidentally stuff a password, token or secret into. Every
 * `details` value is a plain primitive the caller names explicitly
 * (`{ email }`, `{ changed: 'disabled' }`, …), and — as a second,
 * independent line of defence, not a replacement for the first — a
 * denylist scan rejects any key that even *looks* like it might carry a
 * secret before the row is written. That scan exists purely so a future
 * call site that renames a field to `password` by accident fails loudly
 * in tests rather than landing in the append-only log forever; the real
 * guarantee is that no call site in this codebase ever has a reason to
 * pass a secret *value* into a payload built entirely from named,
 * non-secret fields. `audit.test.ts` and the auth route tests both
 * assert a submitted login password never appears anywhere in a written
 * row.
 *
 * There is no update or delete export here, matching the database-level
 * triggers migration 001 installs (`trg_audit_log_no_update`,
 * `trg_audit_log_no_delete`) — the append-only property is enforced
 * twice, once in code and once in the schema, deliberately.
 */
import type { Database } from './db.js';
import { generateId } from './errors.js';

/**
 * Fixed vocabulary of audit actions. Deliberately a flat string union,
 * not a free-form string — every action a caller can log is one this
 * module (and whoever reviews a change to it) has explicitly seen.
 */
export const AUDIT_ACTIONS = [
  'auth.login.success',
  'auth.login.failure',
  'auth.logout',
  'auth.password_change',
  'admin.bootstrap_created',
  'admin.create',
  'admin.update',
  'admin.delete',
  // M7 — mail management (FEATURE_MATRIX.md §3–§7). "Every mutation
  // audited," so one action per DmsDriver write the mail modules expose.
  'mailbox.create',
  'mailbox.password_change',
  'mailbox.restrict',
  'mailbox.quota_set',
  'mailbox.quota_clear',
  'mailbox.delete',
  'mailbox.bulk_restrict',
  'mailbox.bulk_quota',
  'alias.create',
  'alias.update',
  'alias.delete',
  // M8 — security features (FEATURE_MATRIX.md §11, §15, §16, §17, §18).
  'dkim.generate',
  'rspamd.threshold_set',
  'rspamd.symbol_score_set',
  'rspamd.learn_spam',
  'rspamd.learn_ham',
  'clamav.signature_update',
  'fail2ban.ban',
  'fail2ban.unban',
  'sieve.script_update',
  'sieve.script_activate',
  'sieve.script_deactivate',
  'autoresponder.update',
  // M9 — Docker & observability (FEATURE_MATRIX.md §24-26, §32). One
  // action per broker write the Docker modules expose — matching the
  // exact operation names in `@dwg/shared`'s `BROKER_OPERATIONS` so an
  // audit row's action is traceable straight back to the broker call it
  // caused.
  'container.start',
  'container.stop',
  'container.restart',
  'volume.remove',
  'image.prune',
  'console.exec',
  // M10 — jobs, backups, restore, config editor, updates
  // (FEATURE_MATRIX.md §27-29, §31; IMPLEMENTATION_PLAN.md §2.1-§2.2).
  'job.cancel',
  'backup.create',
  'backup.verify',
  'backup.delete',
  'backup.download',
  'backup.restore',
  'config.apply',
  'config.reveal_secret',
  'update.apply_refused',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditResult = 'success' | 'failure';

export interface AuditActor {
  /** `null` for a pre-authentication event (e.g. a failed login) or a system action (bootstrap). */
  readonly adminId: string | null;
  /**
   * Denormalised identity label (e.g. the attempted or actor's email),
   * captured at write time so history reads correctly even after the
   * admin row is gone. Never a password or other secret — the type
   * below has no field that could carry one.
   */
  readonly label: string;
}

export interface AuditTarget {
  readonly type: string;
  readonly id: string;
}

/**
 * Every value a `details` payload may carry. Deliberately restricted to
 * primitives — no nested objects, no arrays — so there is nowhere for a
 * secret to hide inside a structure that "looks" safe at a glance.
 */
export type AuditDetailValue = string | number | boolean | null;
export type AuditDetails = Readonly<Record<string, AuditDetailValue>>;

export interface AuditEvent {
  readonly actor: AuditActor;
  readonly action: AuditAction;
  readonly target: AuditTarget | null;
  readonly result: AuditResult;
  /** The API error code returned to the caller, when `result` is `'failure'`. */
  readonly errorCode?: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  /** Non-sensitive, named fields only — see the module comment. */
  readonly details?: AuditDetails;
}

/**
 * Key fragments that must never appear in a `details` payload, matched
 * case-insensitively against every key. This should never actually fire
 * in real use — no call site should ever have a secret in scope to pass
 * in the first place — so its only job is to fail loudly, in tests, the
 * day some future change tries.
 */
const FORBIDDEN_DETAIL_KEY_PATTERN = /password|token|secret|hash|credential/i;

function assertNoSecretLikeKeys(details: AuditDetails): void {
  for (const key of Object.keys(details)) {
    if (FORBIDDEN_DETAIL_KEY_PATTERN.test(key)) {
      throw new Error(
        `Refusing to write audit event: details key "${key}" looks like it might carry a secret. ` +
          'Audit payloads may only carry non-sensitive, named fields (see platform/audit.ts).',
      );
    }
  }
}

/** One row read back from `audit_log` (M11 — the dashboard's "recent activity" row, UX_ARCHITECTURE.md §6.1 Row 4). Deliberately narrower than {@link AuditEvent}: no `ip`/`userAgent`/`details` — those stay on the audit trail itself, not on a summary feed a dashboard renders to whichever admin happens to load it. */
export interface AuditEventSummary {
  readonly id: string;
  readonly occurredAt: string;
  readonly actorLabel: string;
  readonly action: AuditAction;
  readonly target: string | null;
  readonly result: AuditResult;
}

interface AuditLogRow {
  readonly id: string;
  readonly occurred_at: string;
  readonly actor_label: string;
  readonly action: string;
  readonly target: string | null;
  readonly result: string;
}

/** The most recent `limit` audit events, newest first — a plain read against the append-only log (§7.6), no write path of its own. */
export function listRecentAuditEvents(db: Database, limit: number): readonly AuditEventSummary[] {
  const rows = db.all<AuditLogRow>(
    `SELECT id, occurred_at, actor_label, action, target, result
       FROM audit_log
      ORDER BY occurred_at DESC
      LIMIT ?`,
    [limit],
  );
  return rows.map((row) => ({
    id: row.id,
    occurredAt: row.occurred_at,
    actorLabel: row.actor_label,
    action: row.action as AuditAction,
    target: row.target,
    result: row.result as AuditResult,
  }));
}

/** Appends one row to `audit_log`. There is no corresponding update/delete export — see the module comment. */
export function recordAuditEvent(db: Database, event: AuditEvent): void {
  const details: AuditDetails = {
    ...(event.details ?? {}),
    errorCode: event.errorCode ?? null,
  };
  assertNoSecretLikeKeys(details);

  db.run(
    `INSERT INTO audit_log
       (id, occurred_at, actor_admin_id, actor_label, action, target, result, ip_address, user_agent, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      generateId('al'),
      new Date().toISOString(),
      event.actor.adminId,
      event.actor.label,
      event.action,
      event.target ? `${event.target.type}:${event.target.id}` : null,
      event.result,
      event.ip,
      event.userAgent,
      JSON.stringify(details),
    ],
  );
}
