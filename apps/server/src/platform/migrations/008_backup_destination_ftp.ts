/**
 * M13 — FTP fields on the remote destination config (docs/AGENT_BRIEF).
 *
 * Adds the FTP/FTPS connection columns alongside migration 007's S3 ones on the
 * single-row `backup_destination` table. `ftp_password` is stored for the same
 * reason `s3_secret_access_key` is — the server must present it to log in — and
 * is masked on every read path, revealed only through the audited endpoint, and
 * never logged. `ftp_secure` is FTPS (explicit TLS), stored as INTEGER 0/1.
 *
 * ALTER TABLE ADD COLUMN, the same additive shape migrations 004/006/007 use.
 * Existing rows keep their `type` (`none` or `s3`); the new columns are simply
 * NULL until an operator configures FTP.
 */
import type { Database } from '../db.js';
import type { Migration } from './runner.js';

const UP_SQL = `
  ALTER TABLE backup_destination ADD COLUMN ftp_host TEXT;
  ALTER TABLE backup_destination ADD COLUMN ftp_port INTEGER;
  ALTER TABLE backup_destination ADD COLUMN ftp_user TEXT;
  ALTER TABLE backup_destination ADD COLUMN ftp_password TEXT;
  ALTER TABLE backup_destination ADD COLUMN ftp_path TEXT;
  ALTER TABLE backup_destination ADD COLUMN ftp_secure INTEGER;
`;

function up(db: Database): void {
  db.exec(UP_SQL);
}

export const migration008BackupDestinationFtp: Migration = {
  version: 8,
  name: 'backup_destination_ftp',
  up,
};
