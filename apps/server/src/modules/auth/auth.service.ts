/**
 * Authentication, session lifecycle and brute-force defence
 * (SECURITY.md §3.5; ARCHITECTURE.md §7.4).
 *
 * The organising rule of this module: **every failed login must be
 * indistinguishable from every other failed login** — same response, same
 * error code, and, as far as we can control it, the same amount of work.
 * An attacker must not be able to learn whether an address has an account,
 * whether that account is disabled, or whether it is currently locked out.
 * Each of those would otherwise be a free account-enumeration oracle.
 *
 * That rule is why several branches below deliberately do work whose
 * result is discarded. Those are load-bearing and are marked as such.
 */
import type { AdminRole, AdminSummary } from '@dwg/shared';
import type { Database } from '../../platform/db.js';
import type { AppConfig } from '../../platform/config.js';
import { recordAuditEvent } from '../../platform/audit.js';
import { AdminsRepository, normalizeEmail, type AdminRow } from './admins.repository.js';
import { LoginAttemptsRepository } from './login-attempts.repository.js';
import { SessionsRepository, type SessionRow } from './sessions.repository.js';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from './password.js';
import { generateCsrfToken, generateSessionToken, hashToken } from './tokens.js';

/**
 * Brute-force thresholds (SECURITY.md §3.5).
 *
 * The per-IP allowance is deliberately looser than the per-identifier
 * one. Many legitimate administrators can share one address behind NAT or
 * a corporate egress, so a tight per-IP limit would lock out bystanders;
 * an identifier, by contrast, is one person, and ten failures in fifteen
 * minutes is already far beyond normal mistyping.
 */
export const LOCKOUT_POLICY = Object.freeze({
  windowMinutes: 15,
  maxFailuresPerIdentifier: 10,
  maxFailuresPerIp: 30,
});

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  readonly ipAddress: string;
  readonly userAgent: string | null;
}

export interface LoginSuccess {
  readonly ok: true;
  readonly admin: AdminSummary;
  readonly session: SessionRow;
  /** The raw session token. Returned exactly once, to be set as a cookie. Never stored. */
  readonly token: string;
}

/**
 * Failure carries no reason. The caller cannot accidentally leak *why* a
 * login failed because this type does not carry that information in the
 * first place — the distinction exists only in the audit log.
 */
export interface LoginFailure {
  readonly ok: false;
}

export type LoginOutcome = LoginSuccess | LoginFailure;

export type SessionValidation =
  | { readonly valid: true; readonly session: SessionRow; readonly admin: AdminRow }
  | {
      readonly valid: false;
      readonly reason: 'unknown' | 'revoked' | 'expired' | 'idle' | 'admin-unusable';
    };

export function toAdminSummary(row: AdminRow): AdminSummary {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    disabled: row.disabled,
    forcePasswordChange: row.forcePasswordChange,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}

export interface AuthServiceDeps {
  readonly db: Database;
  readonly admins: AdminsRepository;
  readonly sessions: SessionsRepository;
  readonly attempts: LoginAttemptsRepository;
  readonly config: AppConfig;
}

export class AuthService {
  private readonly db: Database;
  private readonly admins: AdminsRepository;
  private readonly sessions: SessionsRepository;
  private readonly attempts: LoginAttemptsRepository;
  private readonly config: AppConfig;

  constructor(deps: AuthServiceDeps) {
    this.db = deps.db;
    this.admins = deps.admins;
    this.sessions = deps.sessions;
    this.attempts = deps.attempts;
    this.config = deps.config;
  }

  /** True when either counter is over its threshold inside the window. */
  private isLockedOut(identifier: string, ipAddress: string): boolean {
    const since = minutesAgo(LOCKOUT_POLICY.windowMinutes);
    return (
      this.attempts.countFailuresForIdentifierSince(identifier, since) >=
        LOCKOUT_POLICY.maxFailuresPerIdentifier ||
      this.attempts.countFailuresForIpSince(ipAddress, since) >= LOCKOUT_POLICY.maxFailuresPerIp
    );
  }

  private recordFailure(
    identifier: string,
    input: LoginInput,
    errorCode: string,
    adminId: string | null,
  ): LoginFailure {
    this.attempts.record({ identifier, ipAddress: input.ipAddress, success: false });
    recordAuditEvent(this.db, {
      actor: { adminId, label: identifier },
      action: 'auth.login.failure',
      target: null,
      result: 'failure',
      errorCode,
      ip: input.ipAddress,
      userAgent: input.userAgent,
    });
    return { ok: false };
  }

  /**
   * Verifies a credential and, on success, issues a fresh session.
   *
   * Note the shape of the failure paths: unknown address, disabled
   * account and lockout all perform an Argon2 verification before
   * returning, and all return the identical `{ ok: false }`. The audit
   * log records which it was; the caller and the attacker cannot tell.
   */
  async login(input: LoginInput): Promise<LoginOutcome> {
    const identifier = normalizeEmail(input.email);

    if (this.isLockedOut(identifier, input.ipAddress)) {
      // LOAD-BEARING: verify against the dummy hash even though the answer
      // is already decided. Returning early here would make a locked-out
      // response measurably faster than a wrong-password one, which tells
      // an attacker their guessing is being counted — and, since lockout
      // only accrues against addresses that were tried, hints that the
      // address is worth trying. Do not "optimise" this away.
      await verifyPassword(DUMMY_PASSWORD_HASH, input.password);
      return this.recordFailure(identifier, input, 'RATE_LIMITED', null);
    }

    const admin = this.admins.findByEmail(identifier);

    if (admin === undefined) {
      // LOAD-BEARING: an unknown address must cost the same as a known one.
      // Without this the fast path is an account-existence oracle readable
      // from response timing alone (SECURITY.md §3.5).
      await verifyPassword(DUMMY_PASSWORD_HASH, input.password);
      return this.recordFailure(identifier, input, 'INVALID_CREDENTIALS', null);
    }

    const passwordMatches = await verifyPassword(admin.passwordHash, input.password);

    if (!passwordMatches) {
      return this.recordFailure(identifier, input, 'INVALID_CREDENTIALS', admin.id);
    }

    if (admin.disabled) {
      // Correct password, but the account is disabled. Verification has
      // already happened, so this branch costs the same as a success and
      // reveals nothing beyond "login failed".
      return this.recordFailure(identifier, input, 'ACCOUNT_DISABLED', admin.id);
    }

    // Success. Clearing the identifier's failures stops a user who
    // mistyped several times from staying near lockout after proving they
    // know the password.
    this.attempts.record({ identifier, ipAddress: input.ipAddress, success: true });
    this.attempts.clearFailuresForIdentifier(identifier);

    const token = generateSessionToken();
    const session = this.sessions.create({
      adminId: admin.id,
      tokenHash: hashToken(token),
      csrfToken: generateCsrfToken(),
      expiresAt: hoursFromNow(this.config.session.absoluteTtlHours),
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });

    recordAuditEvent(this.db, {
      actor: { adminId: admin.id, label: admin.email },
      action: 'auth.login.success',
      target: null,
      result: 'success',
      ip: input.ipAddress,
      userAgent: input.userAgent,
    });

    return { ok: true, admin: toAdminSummary(admin), session, token };
  }

  /**
   * Resolves a raw session token to a live session, applying revocation,
   * absolute expiry and idle timeout in that order. Returns a reason on
   * failure so the caller can audit a revoked-token replay differently
   * from an unrecognised one — that distinction stays server-side and is
   * never surfaced to the client.
   */
  validateSession(token: string): SessionValidation {
    const session = this.sessions.findByTokenHash(hashToken(token));
    if (session === undefined) return { valid: false, reason: 'unknown' };
    if (session.revokedAt !== null) return { valid: false, reason: 'revoked' };

    const now = Date.now();
    if (Date.parse(session.expiresAt) <= now) return { valid: false, reason: 'expired' };

    const idleDeadline =
      Date.parse(session.lastSeenAt) + this.config.session.idleTtlHours * 3_600_000;
    if (idleDeadline <= now) return { valid: false, reason: 'idle' };

    const admin = this.admins.findById(session.adminId);
    // An administrator disabled mid-session loses it on the very next
    // request. This is the concrete payoff of server-side sessions over a
    // stateless token, which would stay valid until it expired.
    if (admin === undefined || admin.disabled) {
      return { valid: false, reason: 'admin-unusable' };
    }

    this.sessions.touch(session.id, new Date(now).toISOString());
    return { valid: true, session, admin };
  }

  logout(session: SessionRow, admin: AdminRow, ipAddress: string, userAgent: string | null): void {
    this.sessions.revoke(session.id, new Date().toISOString());
    recordAuditEvent(this.db, {
      actor: { adminId: admin.id, label: admin.email },
      action: 'auth.logout',
      target: null,
      result: 'success',
      ip: ipAddress,
      userAgent,
    });
  }

  /**
   * Changes a password after re-verifying the current one, then revokes
   * every *other* session for that administrator (SECURITY.md §3.5).
   *
   * Sparing the calling session is deliberate: the usual reason to change
   * a password is suspicion that it leaked, and the point of the sweep is
   * to evict whoever else may be holding a session. Logging the
   * legitimate user out of their own browser at the same moment adds no
   * security and makes the safe action feel punitive.
   */
  async changePassword(
    admin: AdminRow,
    currentSession: SessionRow,
    currentPassword: string,
    newPassword: string,
    ipAddress: string,
    userAgent: string | null,
  ): Promise<{ ok: true; admin: AdminSummary } | { ok: false }> {
    const matches = await verifyPassword(admin.passwordHash, currentPassword);
    if (!matches) {
      recordAuditEvent(this.db, {
        actor: { adminId: admin.id, label: admin.email },
        action: 'auth.password_change',
        target: null,
        result: 'failure',
        errorCode: 'INVALID_CREDENTIALS',
        ip: ipAddress,
        userAgent,
      });
      return { ok: false };
    }

    const newHash = await hashPassword(newPassword);
    const revokedCount = this.db.transaction(() => {
      this.admins.updatePassword(admin.id, newHash);
      return this.sessions.revokeAllForAdmin(admin.id, new Date().toISOString(), currentSession.id);
    });

    recordAuditEvent(this.db, {
      actor: { adminId: admin.id, label: admin.email },
      action: 'auth.password_change',
      target: null,
      result: 'success',
      ip: ipAddress,
      userAgent,
      // A count, not identifiers: enough to notice that a change evicted
      // sessions the administrator did not expect to exist.
      details: { otherSessionsRevoked: revokedCount },
    });

    const updated = this.admins.findById(admin.id);
    return { ok: true, admin: toAdminSummary(updated ?? { ...admin, passwordHash: newHash }) };
  }

  /** Housekeeping, safe to call periodically. Never what causes a session to stop authenticating — validation already handles that. */
  pruneExpired(): { sessions: number; attempts: number } {
    const now = new Date().toISOString();
    return {
      sessions: this.sessions.deleteExpiredBefore(now),
      attempts: this.attempts.pruneBefore(minutesAgo(LOCKOUT_POLICY.windowMinutes * 4)),
    };
  }
}

export type { AdminRole };
