/**
 * Initial schema: the tables listed in ARCHITECTURE.md §7.3, minus
 * `schema_migrations` itself (bootstrapped by the runner — see the
 * comment in `runner.ts`). All tables are `STRICT` (SQLite column-type
 * enforcement). Timestamps are consistently ISO-8601 text (`TEXT`,
 * `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`-shaped, produced by
 * `Date.prototype.toISOString()` at the application layer) so they sort
 * and compare correctly as plain strings. Entity IDs are
 * application-generated `TEXT` (see `platform/errors.ts`'s `generateId`
 * — the same short/sortable/collision-resistant shape used for
 * `errorId`), not autoincrementing integers, so nothing about row
 * counts is exposed by an ID.
 */
import type { Database } from '../db.js';
import type { Migration } from './runner.js';

const UP_SQL = `
  CREATE TABLE admins (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0,
    force_password_change INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  -- Server-side sessions (ARCHITECTURE.md §7.4): only the token *hash* is
  -- ever stored, never the token itself.
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    revoked_at TEXT
  ) STRICT;
  CREATE INDEX idx_sessions_admin_id ON sessions(admin_id);
  CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

  -- Brute-force detection/lockout. identifier is whatever was attempted
  -- (an email), kept separate from ip_address so both per-account and
  -- per-IP throttling can query this table directly.
  CREATE TABLE login_attempts (
    id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL,
    ip_address TEXT NOT NULL,
    success INTEGER NOT NULL,
    attempted_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX idx_login_attempts_identifier_time ON login_attempts(identifier, attempted_at);
  CREATE INDEX idx_login_attempts_ip_time ON login_attempts(ip_address, attempted_at);

  -- Append-only security record (ARCHITECTURE.md §7.6). actor_label
  -- denormalises the actor's identity (e.g. email) at write time so
  -- history reads correctly even after the admin row is gone;
  -- actor_admin_id is kept too for joins while the admin still exists.
  -- details is non-sensitive JSON text only — never a password, private
  -- key, session token or secret value (enforced by the audit-log write
  -- path, not by this schema).
  CREATE TABLE audit_log (
    id TEXT PRIMARY KEY,
    occurred_at TEXT NOT NULL,
    actor_admin_id TEXT REFERENCES admins(id) ON DELETE SET NULL,
    actor_label TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    result TEXT NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    details TEXT
  ) STRICT;
  CREATE INDEX idx_audit_log_occurred_at ON audit_log(occurred_at);
  CREATE INDEX idx_audit_log_actor_admin_id ON audit_log(actor_admin_id);

  -- "Append-only" is a stated invariant (ARCHITECTURE.md §7.6), not just
  -- a convention: these triggers make UPDATE/DELETE fail at the database
  -- layer rather than relying on every future call site to remember not
  -- to issue one.
  CREATE TRIGGER trg_audit_log_no_update
  BEFORE UPDATE ON audit_log
  BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only: updates are not permitted');
  END;

  CREATE TRIGGER trg_audit_log_no_delete
  BEFORE DELETE ON audit_log
  BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only: deletes are not permitted');
  END;

  -- Long-running operations (ARCHITECTURE.md §7.5). status is a small
  -- fixed vocabulary enforced at the service layer, not by a SQL CHECK,
  -- to keep this migration simple to extend later.
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0,
    created_by_admin_id TEXT REFERENCES admins(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    error_message TEXT,
    metadata TEXT
  ) STRICT;
  CREATE INDEX idx_jobs_status ON jobs(status);
  CREATE INDEX idx_jobs_created_at ON jobs(created_at);

  CREATE TABLE job_logs (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    logged_at TEXT NOT NULL,
    level TEXT NOT NULL,
    message TEXT NOT NULL
  ) STRICT;
  CREATE INDEX idx_job_logs_job_id_time ON job_logs(job_id, logged_at);

  -- Backup metadata (IMPLEMENTATION_PLAN.md §2.1). manifest is the
  -- self-describing JSON document written alongside the archive (schema
  -- version, DMS image digest, panel version, volume list, per-entry
  -- checksums, …) duplicated here so it's queryable without opening the
  -- archive.
  CREATE TABLE backups (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    created_by_admin_id TEXT REFERENCES admins(id) ON DELETE SET NULL,
    file_path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    checksum TEXT NOT NULL,
    manifest TEXT NOT NULL,
    verification_status TEXT NOT NULL DEFAULT 'unverified',
    verified_at TEXT
  ) STRICT;
  CREATE INDEX idx_backups_created_at ON backups(created_at);

  -- Our own metric time series (ARCHITECTURE.md §7.8) — the only source
  -- of spam/queue trend data, since Rspamd's own history is a 200-entry
  -- ring buffer lost on restart.
  CREATE TABLE metric_samples (
    id TEXT PRIMARY KEY,
    sampled_at TEXT NOT NULL,
    metric TEXT NOT NULL,
    value REAL NOT NULL,
    tags TEXT
  ) STRICT;
  CREATE INDEX idx_metric_samples_metric_time ON metric_samples(metric, sampled_at);

  CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    dedupe_key TEXT NOT NULL UNIQUE,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    created_at TEXT NOT NULL,
    read_at TEXT,
    resolved_at TEXT
  ) STRICT;
  CREATE INDEX idx_notifications_created_at ON notifications(created_at);

  -- Runtime configuration. value is JSON text so a single generic table
  -- covers arbitrarily-shaped settings without a schema migration per key.
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
`;

function up(db: Database): void {
  db.exec(UP_SQL);
}

export const migration001Initial: Migration = {
  version: 1,
  name: 'initial',
  up,
};
