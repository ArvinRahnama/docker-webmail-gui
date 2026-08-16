/**
 * M3 additions to the auth-related tables migration 001 already created
 * (ARCHITECTURE.md §7.3, §7.4; SECURITY.md §3.6, §3.9).
 *
 * - `admins.role`: a single `'administrator'` value for now (see
 *   `@dwg/shared`'s `AdminRoleSchema`), modelled as a plain TEXT column
 *   rather than a SQL CHECK enum so that adding a second role later is a
 *   value, not a migration to this column's constraint.
 * - `sessions.csrf_token`: the per-session synchroniser token
 *   (SECURITY.md §3.6). Stored in **plaintext**, unlike `token_hash` for
 *   the session token itself — and deliberately so. The session token is
 *   a bearer credential shown to the browser exactly once (at
 *   `Set-Cookie` time) and never needs to be produced again, so only its
 *   hash need ever exist server-side. The CSRF token is the opposite: the
 *   SPA re-fetches it from `GET /api/v1/auth/csrf-token` on demand
 *   (e.g. after a page reload), so the server must be able to *return*
 *   the same value again — which a one-way hash cannot do. This is safe
 *   because the CSRF token is not itself a bearer credential: on its own,
 *   without the `HttpOnly; SameSite=Strict` session cookie a cross-site
 *   page cannot obtain, it authorises nothing.
 *
 * Both new columns are added `NOT NULL` with a placeholder `DEFAULT` to
 * satisfy SQLite's requirement that `ALTER TABLE ADD COLUMN NOT NULL`
 * supply one for any existing rows. In practice no pre-existing row is
 * ever backfilled with the placeholder: migration 001 shipped before M3
 * added any route capable of creating an admin or a session, so this
 * table is always empty the first time 002 runs against a real database.
 */
import type { Database } from '../db.js';
import type { Migration } from './runner.js';

const UP_SQL = `
  ALTER TABLE admins ADD COLUMN role TEXT NOT NULL DEFAULT 'administrator';
  ALTER TABLE sessions ADD COLUMN csrf_token TEXT NOT NULL DEFAULT '';
`;

function up(db: Database): void {
  db.exec(UP_SQL);
}

export const migration002Auth: Migration = {
  version: 2,
  name: 'auth',
  up,
};
