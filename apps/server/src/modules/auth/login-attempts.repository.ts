/**
 * `login_attempts` table access — the data behind brute-force lockout
 * (SECURITY.md §3.5). Every query is a fully static, parameterised
 * statement (SECURITY.md §3.8).
 *
 * Two independent counters, because they defend against different
 * attacks and neither subsumes the other:
 *
 * - **Per identifier.** Stops a slow, distributed guessing run against
 *   one account, where every request arrives from a different address and
 *   no single IP ever looks suspicious.
 * - **Per IP.** Stops one host spraying a common password across many
 *   accounts, where no single account accumulates enough failures to lock.
 *
 * Both windows are time-based and self-clearing: a lockout expires on its
 * own rather than needing an administrator to unlock it. That matters for
 * a mail panel, where the locked-out person may be the only administrator
 * and would otherwise have no way back in.
 */
import type { Database } from '../../platform/db.js';
import { generateId } from '../../platform/errors.js';

export interface RecordAttemptInput {
  /** The submitted account identifier, already normalised by the caller so counting is consistent. */
  readonly identifier: string;
  readonly ipAddress: string;
  readonly success: boolean;
}

export class LoginAttemptsRepository {
  constructor(private readonly db: Database) {}

  record(input: RecordAttemptInput): void {
    this.db.run(
      'INSERT INTO login_attempts (id, identifier, ip_address, success, attempted_at) VALUES (?, ?, ?, ?, ?)',
      [
        generateId('att'),
        input.identifier,
        input.ipAddress,
        input.success ? 1 : 0,
        new Date().toISOString(),
      ],
    );
  }

  /** Failures for one identifier at or after `since` (an ISO-8601 timestamp). */
  countFailuresForIdentifierSince(identifier: string, since: string): number {
    const row = this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM login_attempts WHERE identifier = ? AND success = 0 AND attempted_at >= ?',
      [identifier, since],
    );
    return row?.n ?? 0;
  }

  /** Failures from one address at or after `since`. */
  countFailuresForIpSince(ipAddress: string, since: string): number {
    const row = this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM login_attempts WHERE ip_address = ? AND success = 0 AND attempted_at >= ?',
      [ipAddress, since],
    );
    return row?.n ?? 0;
  }

  /**
   * Clears the failure history for an identifier after a successful
   * login.
   *
   * Without this, someone who mistypes their password nine times and then
   * gets it right stays one failure away from locking themselves out for
   * the rest of the window — punishing the legitimate user for having
   * succeeded. Proving knowledge of the password is exactly the evidence
   * that the preceding failures were not an attack.
   *
   * Deliberately scoped to the identifier and not the IP: an attacker who
   * happens to know one valid credential must not be able to clear the
   * per-IP counter and resume spraying other accounts from the same host.
   */
  clearFailuresForIdentifier(identifier: string): void {
    this.db.run('DELETE FROM login_attempts WHERE identifier = ? AND success = 0', [identifier]);
  }

  /** Housekeeping: drops attempts older than `before`, which are outside every window. */
  pruneBefore(before: string): number {
    const result = this.db.run('DELETE FROM login_attempts WHERE attempted_at < ?', [before]);
    return Number(result.changes);
  }
}
