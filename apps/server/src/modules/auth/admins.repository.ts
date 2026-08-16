/**
 * `admins` table access (ARCHITECTURE.md §7.3). Every query is a fully
 * static, parameterised statement (SECURITY.md §3.8) — this is the only
 * module that reads or writes this table directly.
 */
import type { AdminRole } from '@dwg/shared';
import type { Database } from '../../platform/db.js';
import { generateId } from '../../platform/errors.js';

export interface AdminRow {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly role: AdminRole;
  readonly disabled: boolean;
  readonly forcePasswordChange: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface RawAdminRow {
  readonly id: string;
  readonly email: string;
  readonly password_hash: string;
  readonly role: string;
  readonly disabled: number;
  readonly force_password_change: number;
  readonly created_at: string;
  readonly updated_at: string;
}

function fromRaw(row: RawAdminRow): AdminRow {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    role: row.role as AdminRole,
    disabled: row.disabled !== 0,
    forcePasswordChange: row.force_password_change !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Lowercases and trims an email so lookup and storage are consistent.
 * SQLite's default `TEXT UNIQUE` index (migration 001) uses byte-wise
 * comparison, so normalising here — applied on every read and write
 * path, never just one — is what actually makes email uniqueness
 * case-insensitive in practice.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface CreateAdminInput {
  readonly email: string;
  readonly passwordHash: string;
  readonly role: AdminRole;
  readonly forcePasswordChange: boolean;
}

export interface UpdateAdminPatch {
  readonly disabled?: boolean;
  readonly role?: AdminRole;
}

// Written out in full rather than composed from a shared prefix. Building
// SQL by interpolation is the pattern SECURITY.md §3.8 bans and the lint
// rules flag, and a constant that is "obviously safe today" is exactly how
// that habit gets established. Two whole static strings cost a line of
// duplication and leave nothing to review.
const SELECT_BY_EMAIL =
  'SELECT id, email, password_hash, role, disabled, force_password_change, created_at, updated_at FROM admins WHERE email = ?';
const SELECT_BY_ID =
  'SELECT id, email, password_hash, role, disabled, force_password_change, created_at, updated_at FROM admins WHERE id = ?';

export class AdminsRepository {
  constructor(private readonly db: Database) {}

  findByEmail(email: string): AdminRow | undefined {
    const row = this.db.get<RawAdminRow>(SELECT_BY_EMAIL, [normalizeEmail(email)]);
    return row ? fromRaw(row) : undefined;
  }

  findById(id: string): AdminRow | undefined {
    const row = this.db.get<RawAdminRow>(SELECT_BY_ID, [id]);
    return row ? fromRaw(row) : undefined;
  }

  list(): AdminRow[] {
    return this.db
      .all<RawAdminRow>(
        'SELECT id, email, password_hash, role, disabled, force_password_change, created_at, updated_at FROM admins ORDER BY created_at',
      )
      .map(fromRaw);
  }

  count(): number {
    const row = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM admins');
    return row?.n ?? 0;
  }

  /** Count of administrators with `disabled = 0` — the invariant guard's notion of "usable" accounts. */
  countEnabled(): number {
    const row = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM admins WHERE disabled = 0');
    return row?.n ?? 0;
  }

  create(input: CreateAdminInput): AdminRow {
    const now = new Date().toISOString();
    const row: AdminRow = {
      id: generateId('adm'),
      email: normalizeEmail(input.email),
      passwordHash: input.passwordHash,
      role: input.role,
      disabled: false,
      forcePasswordChange: input.forcePasswordChange,
      createdAt: now,
      updatedAt: now,
    };
    this.db.run(
      `INSERT INTO admins (id, email, password_hash, role, disabled, force_password_change, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.email,
        row.passwordHash,
        row.role,
        row.disabled ? 1 : 0,
        row.forcePasswordChange ? 1 : 0,
        row.createdAt,
        row.updatedAt,
      ],
    );
    return row;
  }

  /**
   * Applies a partial update and bumps `updated_at`. Never touches
   * `password_hash` — see {@link updatePassword} for that, which is
   * deliberately a separate, narrower method.
   */
  update(id: string, patch: UpdateAdminPatch): void {
    const now = new Date().toISOString();
    if (patch.disabled !== undefined && patch.role !== undefined) {
      this.db.run('UPDATE admins SET disabled = ?, role = ?, updated_at = ? WHERE id = ?', [
        patch.disabled ? 1 : 0,
        patch.role,
        now,
        id,
      ]);
      return;
    }
    if (patch.disabled !== undefined) {
      this.db.run('UPDATE admins SET disabled = ?, updated_at = ? WHERE id = ?', [
        patch.disabled ? 1 : 0,
        now,
        id,
      ]);
      return;
    }
    if (patch.role !== undefined) {
      this.db.run('UPDATE admins SET role = ?, updated_at = ? WHERE id = ?', [patch.role, now, id]);
    }
    // Neither field given: a deliberate no-op rather than an error, so callers can pass a fully-optional patch through unconditionally.
  }

  /** Sets a new password hash and clears `force_password_change` — a password change always satisfies that requirement, whatever triggered it. */
  updatePassword(id: string, passwordHash: string): void {
    const now = new Date().toISOString();
    this.db.run(
      'UPDATE admins SET password_hash = ?, force_password_change = 0, updated_at = ? WHERE id = ?',
      [passwordHash, now, id],
    );
  }

  /** Deletes the row. Sessions cascade via the `sessions.admin_id` foreign key (`ON DELETE CASCADE`, migration 001). */
  delete(id: string): void {
    this.db.run('DELETE FROM admins WHERE id = ?', [id]);
  }
}
