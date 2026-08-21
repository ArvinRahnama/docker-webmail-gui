/**
 * M10 addition: `config_snapshots` (FEATURE_MATRIX.md §28-29 "a pre-change
 * snapshot enables rollback"). `jobs`/`job_logs` and `backups` already
 * exist from migration 001 (ARCHITECTURE.md §7.3 lists them as part of the
 * original schema, ahead of the milestone that fills in their behaviour —
 * the same pattern this migration follows for the one table 001 did not
 * anticipate). `values` holds the *complete* allowlisted settings state at
 * snapshot time (secrets included, unmasked) as JSON text — this table is
 * never exposed over the API (`modules/config/config.repository.ts`),
 * mirroring how `sessions.token_hash` is a real column no route ever
 * echoes back.
 *
 * Also adds `jobs.created_by_label`: 001 gave `jobs` a
 * `created_by_admin_id` FK (`ON DELETE SET NULL`, same as `audit_log`) but
 * no denormalised label, so a job row would go anonymous the moment its
 * creating admin is deleted. `audit_log.actor_label` already solves this
 * exact problem for the audit trail (ARCHITECTURE.md §7.6); this column
 * does the same for jobs. Backfilled `''` for any pre-existing row, same
 * placeholder-default reasoning as migration 002 — no route capable of
 * creating a job exists before this milestone, so there is nothing real to
 * backfill in practice.
 */
import type { Database } from '../db.js';
import type { Migration } from './runner.js';

const UP_SQL = `
  CREATE TABLE config_snapshots (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    created_by_admin_id TEXT REFERENCES admins(id) ON DELETE SET NULL,
    created_by_label TEXT NOT NULL,
    values_json TEXT NOT NULL
  ) STRICT;
  CREATE INDEX idx_config_snapshots_created_at ON config_snapshots(created_at);

  ALTER TABLE jobs ADD COLUMN created_by_label TEXT NOT NULL DEFAULT '';
`;

function up(db: Database): void {
  db.exec(UP_SQL);
}

export const migration004Maintenance: Migration = {
  version: 4,
  name: 'maintenance',
  up,
};
