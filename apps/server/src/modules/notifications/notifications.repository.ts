/**
 * SQL access for `notifications` (migration 001 — ARCHITECTURE.md §7.3:
 * "Deduplicated alerts"). Mirrors `modules/backups/backups.repository.ts`'s
 * shape: one named method per row transition, no hand-written SQL
 * anywhere else in this module.
 *
 * `dedupe_key` is `UNIQUE` at the schema level, so {@link upsertActive} is
 * a genuine UPSERT (`INSERT ... ON CONFLICT(dedupe_key) DO UPDATE`), never
 * a read-then-write race between two evaluator ticks. `created_at` and
 * `read_at` are only reset on the transition *out of* `resolved` — an
 * ongoing, already-seen problem that is merely re-detected on the next
 * tick does not jump back to the top of the list or re-count as unread
 * every few minutes; a problem that had cleared and has now recurred does.
 */
import type { Database } from '../../platform/db.js';
import type { NotificationSeverity } from '@dwg/shared';
import { generateId } from '../../platform/errors.js';

export interface NotificationRow {
  readonly id: string;
  /** Internal correlation key — never sent to the client directly; `NotificationsService` uses it to look up a real `link` (see that module's own doc comment). */
  readonly dedupeKey: string;
  readonly severity: NotificationSeverity;
  readonly title: string;
  readonly body: string | null;
  readonly createdAt: string;
  readonly readAt: string | null;
  readonly resolvedAt: string | null;
}

interface RawRow {
  readonly id: string;
  readonly dedupe_key: string;
  readonly severity: string;
  readonly title: string;
  readonly body: string | null;
  readonly created_at: string;
  readonly read_at: string | null;
  readonly resolved_at: string | null;
}

function toRow(raw: RawRow): NotificationRow {
  return {
    id: raw.id,
    dedupeKey: raw.dedupe_key,
    severity: raw.severity as NotificationSeverity,
    title: raw.title,
    body: raw.body,
    createdAt: raw.created_at,
    readAt: raw.read_at,
    resolvedAt: raw.resolved_at,
  };
}

export interface UpsertActiveParams {
  readonly dedupeKey: string;
  readonly severity: NotificationSeverity;
  readonly title: string;
  readonly body: string | null;
}

const DEFAULT_LIST_LIMIT = 50;

export class NotificationsRepository {
  constructor(private readonly db: Database) {}

  /** Marks `dedupeKey` as currently active — inserts a new row the first time this condition is ever observed, or revives/refreshes the existing one otherwise. See the module header for the `created_at`/`read_at` reset rule. */
  upsertActive(params: UpsertActiveParams, now: string): void {
    this.db.run(
      `INSERT INTO notifications (id, dedupe_key, severity, title, body, created_at, read_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT(dedupe_key) DO UPDATE SET
         severity = excluded.severity,
         title = excluded.title,
         body = excluded.body,
         created_at = CASE WHEN resolved_at IS NOT NULL THEN excluded.created_at ELSE created_at END,
         read_at = CASE WHEN resolved_at IS NOT NULL THEN NULL ELSE read_at END,
         resolved_at = NULL`,
      [generateId('ntf'), params.dedupeKey, params.severity, params.title, params.body, now],
    );
  }

  /** No-op when `dedupeKey` has no row, or is already resolved — the evaluator calls this unconditionally for every known-but-not-currently-active condition on every tick. */
  resolveIfActive(dedupeKey: string, resolvedAt: string): void {
    this.db.run(
      `UPDATE notifications SET resolved_at = ? WHERE dedupe_key = ? AND resolved_at IS NULL`,
      [resolvedAt, dedupeKey],
    );
  }

  /** Active problems first (regardless of age), newest within each group first — a long-resolved item should not bury a fresh one just because it's chronologically newer. */
  list(limit: number = DEFAULT_LIST_LIMIT): readonly NotificationRow[] {
    const rows = this.db.all<RawRow>(
      `SELECT * FROM notifications
        ORDER BY (resolved_at IS NULL) DESC, created_at DESC
        LIMIT ?`,
      [limit],
    );
    return rows.map(toRow);
  }

  getById(id: string): NotificationRow | null {
    const row = this.db.get<RawRow>('SELECT * FROM notifications WHERE id = ?', [id]);
    return row ? toRow(row) : null;
  }

  /** Active (`resolved_at IS NULL`) and unread (`read_at IS NULL`) — what the topbar bell badge counts. */
  countUnread(): number {
    const row = this.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM notifications WHERE read_at IS NULL AND resolved_at IS NULL`,
    );
    return row?.count ?? 0;
  }

  /** Idempotent — never overwrites an earlier `read_at` with a later one. */
  markRead(id: string, readAt: string): void {
    this.db.run(`UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ?`, [
      readAt,
      id,
    ]);
  }

  markAllRead(readAt: string): void {
    this.db.run(`UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE read_at IS NULL`, [
      readAt,
    ]);
  }
}
