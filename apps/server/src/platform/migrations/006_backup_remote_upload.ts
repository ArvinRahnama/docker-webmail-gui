/**
 * M13 — per-backup remote-upload state (docs/AGENT_BRIEF; FEATURE_MATRIX §27a).
 *
 * Adds the columns that make an upload a distinct, retryable step separate
 * from taking the backup: which state it is in (pending / uploading /
 * uploaded / failed), where it went, its remote object key, when the remote
 * copy was verified, the last non-secret failure message, and whether the
 * local (VPS) archive still exists.
 *
 * `local_present` is the hinge of the staging model: a backup's local archive
 * is deleted only *after* its remote copy is checksum-verified, at which point
 * this flips to 0 and the row keeps describing a backup that now lives only on
 * the remote. `upload_error` is a safe summary only — the uploader never
 * writes a signed URL or credential into it (SECURITY: secrets never enter the
 * database in readable form).
 *
 * ALTER TABLE ADD COLUMN on the STRICT `backups` table (migration 001), the
 * same additive shape migration 004 used for `jobs.created_by_label`. Existing
 * rows backfill to the column defaults: `pending`, and `local_present = 1`
 * (every pre-existing backup is, by definition, still only local).
 */
import type { Database } from '../db.js';
import type { Migration } from './runner.js';

const UP_SQL = `
  ALTER TABLE backups ADD COLUMN upload_status TEXT NOT NULL DEFAULT 'pending';
  ALTER TABLE backups ADD COLUMN upload_destination TEXT;
  ALTER TABLE backups ADD COLUMN remote_key TEXT;
  ALTER TABLE backups ADD COLUMN uploaded_at TEXT;
  ALTER TABLE backups ADD COLUMN upload_error TEXT;
  ALTER TABLE backups ADD COLUMN local_present INTEGER NOT NULL DEFAULT 1;
`;

function up(db: Database): void {
  db.exec(UP_SQL);
}

export const migration006BackupRemoteUpload: Migration = {
  version: 6,
  name: 'backup_remote_upload',
  up,
};
