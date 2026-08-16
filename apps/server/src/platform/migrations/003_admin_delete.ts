/**
 * Fixes a real conflict between two of 001's own invariants, surfaced by
 * M3's `DELETE /api/v1/admins/:id` (ARCHITECTURE.md §7.3, §7.6):
 *
 * `audit_log.actor_admin_id` is declared `REFERENCES admins(id) ON DELETE
 * SET NULL`, so deleting an administrator makes SQLite null out that
 * column on every audit row they ever acted in — which, for a real
 * administrator, is essentially always at least their own login. SQLite
 * implements a `SET NULL` foreign-key action as a genuine `UPDATE`
 * statement against the child table, and 001's own
 * `trg_audit_log_no_update` trigger aborts *every* update to `audit_log`
 * unconditionally, with no way to tell "the FK action just fired" apart
 * from "a caller tried to edit history." The two were never exercised
 * together until a route that can actually delete an administrator
 * existed, so the conflict was latent rather than deliberate.
 *
 * The fix is narrow: `trg_audit_log_no_update` is redefined with an
 * `UPDATE OF <every content column except actor_admin_id>` clause, so it
 * still fires — and still aborts — for any attempt to alter what a row
 * *says*, but no longer fires for the one column whose schema-declared
 * job is to legitimately go stale once its admin is gone. That column
 * being nulled is not loss of history: `actor_label` (ARCHITECTURE.md
 * §7.6) already denormalises the actor's identity at write time
 * specifically so the row still reads correctly once the admin row
 * doesn't exist. `trg_audit_log_no_delete` is untouched — rows are never
 * removed, only this one already-nullable, already-non-authoritative
 * column changes.
 */
import type { Database } from '../db.js';
import type { Migration } from './runner.js';

const UP_SQL = `
  DROP TRIGGER trg_audit_log_no_update;

  CREATE TRIGGER trg_audit_log_no_update
  BEFORE UPDATE OF id, occurred_at, actor_label, action, target, result, ip_address, user_agent, details
  ON audit_log
  BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only: updates to its recorded content are not permitted');
  END;
`;

function up(db: Database): void {
  db.exec(UP_SQL);
}

export const migration003AdminDelete: Migration = {
  version: 3,
  name: 'admin_delete',
  up,
};
