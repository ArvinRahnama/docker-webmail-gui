/**
 * M13 — scheduled automatic backups (docs/AGENT_BRIEF; FEATURE_MATRIX §27a).
 *
 * A single-row policy table (`id` pinned to 1 by a CHECK, the same
 * one-row-config pattern SQLite deployments use for a settings singleton).
 * The row holds the *policy* the operator sets plus the two anchors the
 * scheduler reasons about:
 *   - `updated_at` — when the policy last changed; the next run after a policy
 *     change is measured one interval from here, so enabling a schedule never
 *     fires an immediate surprise backup.
 *   - `last_run_at` — when the scheduler last fired; once set it becomes the
 *     anchor instead, so a due backup advances the schedule by exactly one
 *     interval with no backlog catch-up.
 *
 * Booleans are stored as INTEGER 0/1 (STRICT tables have no BOOLEAN type).
 * The schedule is re-armed from this table on every server startup, so it
 * survives a redeploy — an in-memory-only timer would silently stop.
 */
import type { Database } from '../db.js';
import type { Migration } from './runner.js';

const UP_SQL = `
  CREATE TABLE backup_schedule (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    frequency TEXT NOT NULL DEFAULT 'off',
    mode TEXT NOT NULL DEFAULT 'warm',
    retention_keep INTEGER NOT NULL DEFAULT 3,
    retention_max_age_days INTEGER,
    upload_to_remote INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    last_run_at TEXT
  ) STRICT;
`;

function up(db: Database): void {
  db.exec(UP_SQL);
}

export const migration005BackupSchedule: Migration = {
  version: 5,
  name: 'backup_schedule',
  up,
};
