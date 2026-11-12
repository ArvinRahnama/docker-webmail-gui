/**
 * User spam / not-spam reports (docker/dms/README.md) the panel has
 * processed.
 *
 * The sender lists themselves live in each mailbox's own Sieve script —
 * the script is the source of truth (`sender-lists-sieve.ts`). This table
 * holds only what the script cannot: which mail-log report lines were
 * already applied (`line_hash`, so a line still inside the next tail of the
 * log is never applied twice) and what each one did, for the activity
 * history in the UI. Rows are pruned after a retention window; the newest
 * `reported_at` doubles as the cursor below which lines are ignored, so
 * pruning can never make an old report replay.
 */
import type { Database } from '../db.js';
import type { Migration } from './runner.js';

const UP_SQL = `
  CREATE TABLE sender_reports (
    line_hash TEXT PRIMARY KEY,
    reported_at TEXT NOT NULL,
    mailbox TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('ham', 'spam')),
    sender TEXT,
    client_ip TEXT,
    list TEXT CHECK (list IN ('allow', 'block')),
    kind TEXT CHECK (kind IN ('address', 'domain', 'ip')),
    value TEXT,
    outcome TEXT NOT NULL,
    processed_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX sender_reports_reported_at ON sender_reports (reported_at);
  CREATE INDEX sender_reports_mailbox ON sender_reports (mailbox, reported_at);
`;

function up(db: Database): void {
  db.exec(UP_SQL);
}

export const migration009SenderReports: Migration = {
  version: 9,
  name: 'sender_reports',
  up,
};
