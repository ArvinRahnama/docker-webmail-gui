/**
 * M13 — remote backup destination configuration (docs/AGENT_BRIEF;
 * FEATURE_MATRIX §27a). Unlike the DMS config editor (which models
 * container-environment settings applied by recreate, and is unsuitable for
 * live panel config), the destination must take effect immediately, so it is a
 * plain live DB row the server reads on every upload.
 *
 * `backup_destination` is the single-row config (id pinned to 1). The secret
 * access key is stored here because the server must present it to the S3
 * signer; it is masked on every read path and revealed only through an
 * explicit, audited endpoint — it never appears in a normal response, a log,
 * or the bundle.
 *
 * `backup_destination_snapshots` is the pre-change snapshot the secrets
 * guardrail requires ("a pre-change snapshot enables rollback"): the full
 * prior config (secret included) is captured before every change. Like
 * `config_snapshots`, this table is never exposed over the API.
 */
import type { Database } from '../db.js';
import type { Migration } from './runner.js';

const UP_SQL = `
  CREATE TABLE backup_destination (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    type TEXT NOT NULL DEFAULT 'none',
    s3_endpoint TEXT,
    s3_region TEXT,
    s3_bucket TEXT,
    s3_access_key_id TEXT,
    s3_secret_access_key TEXT,
    s3_prefix TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE backup_destination_snapshots (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    created_by_admin_id TEXT REFERENCES admins(id) ON DELETE SET NULL,
    created_by_label TEXT NOT NULL,
    config_json TEXT NOT NULL
  ) STRICT;
  CREATE INDEX idx_backup_destination_snapshots_created_at ON backup_destination_snapshots(created_at);
`;

function up(db: Database): void {
  db.exec(UP_SQL);
}

export const migration007BackupDestination: Migration = {
  version: 7,
  name: 'backup_destination',
  up,
};
