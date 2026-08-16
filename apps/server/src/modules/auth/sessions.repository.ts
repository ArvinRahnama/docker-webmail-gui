/**
 * `sessions` table access (ARCHITECTURE.md §7.3, §7.4). Every query is a
 * fully static, parameterised statement (SECURITY.md §3.8).
 *
 * Two properties this module exists to guarantee:
 *
 * 1. **Only a token hash is ever stored.** The caller hands us
 *    `tokenHash` (see `tokens.ts`); the raw session token never reaches
 *    this layer at all, so there is no code path here that could persist
 *    one by accident.
 *
 * 2. **Revocation is a tombstone, not a delete.** `revoked_at` is set
 *    rather than the row removed. That costs a little storage and buys a
 *    real signal: a request presenting a token whose session row exists
 *    but is revoked is meaningfully different from one presenting a token
 *    that never existed. The first is a replay of a logged-out or
 *    force-invalidated credential and is worth recording; the second is
 *    noise. `deleteExpiredBefore` reclaims the rows later.
 *
 * The security-relevant consequence is unchanged from ARCHITECTURE.md
 * §7.4: a revoked session stops authenticating on the very next request,
 * which is precisely what a stateless token could not promise.
 */
import type { Database } from '../../platform/db.js';
import { generateId } from '../../platform/errors.js';

export interface SessionRow {
  readonly id: string;
  readonly adminId: string;
  readonly tokenHash: string;
  readonly csrfToken: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastSeenAt: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly revokedAt: string | null;
}

interface RawSessionRow {
  readonly id: string;
  readonly admin_id: string;
  readonly token_hash: string;
  readonly csrf_token: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly last_seen_at: string;
  readonly ip_address: string | null;
  readonly user_agent: string | null;
  readonly revoked_at: string | null;
}

function fromRaw(row: RawSessionRow): SessionRow {
  return {
    id: row.id,
    adminId: row.admin_id,
    tokenHash: row.token_hash,
    csrfToken: row.csrf_token,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    revokedAt: row.revoked_at,
  };
}

// Written out in full rather than composed from a shared prefix — see the
// same note in `admins.repository.ts`. Interpolated SQL is the pattern
// SECURITY.md §3.8 bans, and the habit matters more than any single case.
const SELECT_BY_TOKEN_HASH =
  'SELECT id, admin_id, token_hash, csrf_token, created_at, expires_at, last_seen_at, ip_address, user_agent, revoked_at FROM sessions WHERE token_hash = ?';
const SELECT_BY_ID =
  'SELECT id, admin_id, token_hash, csrf_token, created_at, expires_at, last_seen_at, ip_address, user_agent, revoked_at FROM sessions WHERE id = ?';

export interface CreateSessionInput {
  readonly adminId: string;
  /** SHA-256 hash of the session token. The raw token must never be passed here. */
  readonly tokenHash: string;
  readonly csrfToken: string;
  readonly expiresAt: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export class SessionsRepository {
  constructor(private readonly db: Database) {}

  create(input: CreateSessionInput): SessionRow {
    const now = new Date().toISOString();
    const row: SessionRow = {
      id: generateId('ses'),
      adminId: input.adminId,
      tokenHash: input.tokenHash,
      csrfToken: input.csrfToken,
      createdAt: now,
      expiresAt: input.expiresAt,
      lastSeenAt: now,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      revokedAt: null,
    };
    this.db.run(
      `INSERT INTO sessions (id, admin_id, token_hash, csrf_token, created_at, expires_at, last_seen_at, ip_address, user_agent, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        row.id,
        row.adminId,
        row.tokenHash,
        row.csrfToken,
        row.createdAt,
        row.expiresAt,
        row.lastSeenAt,
        row.ipAddress,
        row.userAgent,
      ],
    );
    return row;
  }

  /**
   * Returns the row for a token hash whether or not it is still valid.
   * Validity — expiry, idle timeout, revocation — is decided by the
   * service, not here, so that it can tell the cases apart and audit a
   * revoked-token replay differently from an unknown token.
   */
  findByTokenHash(tokenHash: string): SessionRow | undefined {
    const row = this.db.get<RawSessionRow>(SELECT_BY_TOKEN_HASH, [tokenHash]);
    return row ? fromRaw(row) : undefined;
  }

  findById(id: string): SessionRow | undefined {
    const row = this.db.get<RawSessionRow>(SELECT_BY_ID, [id]);
    return row ? fromRaw(row) : undefined;
  }

  /** Records activity for the idle-timeout clock. */
  touch(id: string, at: string): void {
    this.db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [at, id]);
  }

  /** Marks one session revoked. Already-revoked rows keep their original timestamp. */
  revoke(id: string, at: string): void {
    this.db.run('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [at, id]);
  }

  /**
   * Revokes every live session for an administrator, optionally sparing
   * one. Used on password change: the session that performed the change
   * stays usable, every other one dies immediately (SECURITY.md §3.5).
   */
  revokeAllForAdmin(adminId: string, at: string, exceptSessionId?: string): number {
    const result =
      exceptSessionId === undefined
        ? this.db.run(
            'UPDATE sessions SET revoked_at = ? WHERE admin_id = ? AND revoked_at IS NULL',
            [at, adminId],
          )
        : this.db.run(
            'UPDATE sessions SET revoked_at = ? WHERE admin_id = ? AND revoked_at IS NULL AND id != ?',
            [at, adminId, exceptSessionId],
          );
    return Number(result.changes);
  }

  /** Reclaims rows that expired before `before`. Housekeeping only — it must never be what makes a session stop authenticating. */
  deleteExpiredBefore(before: string): number {
    const result = this.db.run('DELETE FROM sessions WHERE expires_at < ?', [before]);
    return Number(result.changes);
  }
}
