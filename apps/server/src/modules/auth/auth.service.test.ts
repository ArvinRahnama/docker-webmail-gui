import { describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../platform/db.js';
import { migrations, runMigrations } from '../../platform/migrations/index.js';
import { loadConfig } from '../../platform/config.js';
import { AdminsRepository } from './admins.repository.js';
import { LoginAttemptsRepository } from './login-attempts.repository.js';
import { SessionsRepository } from './sessions.repository.js';
import { hashPassword } from './password.js';
import { hashToken } from './tokens.js';
import { AuthService, LOCKOUT_POLICY } from './auth.service.js';

const PASSWORD = 'correct-horse-battery-staple';
const EMAIL = 'admin@example.com';
const IP = '203.0.113.5';

interface Harness {
  readonly db: Database;
  readonly service: AuthService;
  readonly admins: AdminsRepository;
  readonly sessions: SessionsRepository;
  readonly attempts: LoginAttemptsRepository;
}

async function setUp(
  options: { disabled?: boolean; createAdmin?: boolean } = {},
): Promise<Harness> {
  const db = createDatabase(':memory:');
  runMigrations(db, migrations);

  const admins = new AdminsRepository(db);
  const sessions = new SessionsRepository(db);
  const attempts = new LoginAttemptsRepository(db);
  const config = loadConfig({});
  const service = new AuthService({ db, admins, sessions, attempts, config });

  if (options.createAdmin !== false) {
    const admin = admins.create({
      email: EMAIL,
      passwordHash: await hashPassword(PASSWORD),
      role: 'administrator',
      forcePasswordChange: false,
    });
    if (options.disabled === true) admins.update(admin.id, { disabled: true });
  }

  return { db, service, admins, sessions, attempts };
}

function login(service: AuthService, password: string, email = EMAIL, ip = IP) {
  return service.login({ email, password, ipAddress: ip, userAgent: 'test-agent/1.0' });
}

describe('AuthService.login — success', () => {
  it('issues a session whose stored hash matches the returned token, and never stores the token itself', async () => {
    const { db, service, sessions } = await setUp();

    const result = await login(service, PASSWORD);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(sessions.findByTokenHash(hashToken(result.token))?.id).toBe(result.session.id);

    // The raw token must appear nowhere in the sessions table.
    const rows = db.all<{ token_hash: string; csrf_token: string }>(
      'SELECT token_hash, csrf_token FROM sessions',
    );
    for (const row of rows) {
      expect(row.token_hash).not.toBe(result.token);
      expect(row.csrf_token).not.toBe(result.token);
    }

    db.close();
  });

  it('issues a different token on each login, so a session is never reused across logins', async () => {
    const { db, service } = await setUp();

    const first = await login(service, PASSWORD);
    const second = await login(service, PASSWORD);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.token).not.toBe(first.token);
    expect(second.session.id).not.toBe(first.session.id);

    db.close();
  });

  it('clears the identifier failure history, so earlier mistypes do not leave the user near lockout', async () => {
    const { db, service, attempts } = await setUp();

    for (let i = 0; i < 5; i += 1) await login(service, 'wrong-password');
    expect(attempts.countFailuresForIdentifierSince(EMAIL, '1970-01-01T00:00:00.000Z')).toBe(5);

    await login(service, PASSWORD);
    expect(attempts.countFailuresForIdentifierSince(EMAIL, '1970-01-01T00:00:00.000Z')).toBe(0);

    db.close();
  });
});

describe('AuthService.login — failures are indistinguishable', () => {
  it('returns an identical result for an unknown address and a wrong password', async () => {
    const { db, service } = await setUp();

    const unknown = await login(service, PASSWORD, 'nobody@example.com');
    const wrong = await login(service, 'wrong-password');

    expect(unknown).toEqual({ ok: false });
    expect(wrong).toEqual({ ok: false });

    db.close();
  });

  it('refuses a disabled account without revealing that it exists', async () => {
    const { db, service } = await setUp({ disabled: true });

    // Correct password, disabled account — still the same bare failure.
    expect(await login(service, PASSWORD)).toEqual({ ok: false });

    db.close();
  });

  /**
   * The timing half of account-enumeration defence (SECURITY.md §3.5).
   *
   * An identical response body is not sufficient: if the unknown-address
   * path returned before hashing, it would be dramatically faster than a
   * real verification, and that difference alone tells an attacker which
   * addresses have accounts. `login` therefore verifies against a dummy
   * hash when no account exists.
   *
   * The assertion is a loose ratio rather than a tight bound, because CI
   * timing is noisy and a flaky security test gets deleted. It still has
   * real teeth: Argon2 at the configured cost takes tens of milliseconds,
   * so removing the dummy verify would drop the unknown-address path by
   * orders of magnitude and fail this comfortably.
   */
  it('spends comparable time on an unknown address as on a wrong password', async () => {
    const { db, service } = await setUp();

    // Warm up, so first-call overhead lands on neither measurement.
    await login(service, 'warmup-password');

    const timeOf = async (email: string): Promise<number> => {
      const started = performance.now();
      await login(service, 'some-wrong-password', email);
      return performance.now() - started;
    };

    const unknownMs = await timeOf('nobody@example.com');
    const knownMs = await timeOf(EMAIL);

    expect(unknownMs).toBeGreaterThan(knownMs * 0.4);

    db.close();
  });
});

describe('AuthService.login — lockout', () => {
  it('locks the identifier at the threshold and keeps refusing the correct password', async () => {
    const { db, service } = await setUp();

    for (let i = 0; i < LOCKOUT_POLICY.maxFailuresPerIdentifier; i += 1) {
      await login(service, 'wrong-password');
    }

    // Correct credentials now, but the window has not passed.
    expect(await login(service, PASSWORD)).toEqual({ ok: false });

    db.close();
  });

  it('self-clears once the window has passed, without an administrator unlocking anything', async () => {
    const { db, service, attempts } = await setUp();

    // Backdate every failure to just outside the window, simulating the
    // passage of time without sleeping in the test.
    const outside = new Date(
      Date.now() - (LOCKOUT_POLICY.windowMinutes + 1) * 60_000,
    ).toISOString();
    for (let i = 0; i < LOCKOUT_POLICY.maxFailuresPerIdentifier; i += 1) {
      attempts.record({ identifier: EMAIL, ipAddress: IP, success: false });
    }
    db.run('UPDATE login_attempts SET attempted_at = ?', [outside]);

    const result = await login(service, PASSWORD);
    expect(result.ok).toBe(true);

    db.close();
  });

  it('counts per identifier, so locking one account does not lock another from the same address', async () => {
    const { db, service, admins } = await setUp();
    admins.create({
      email: 'second@example.com',
      passwordHash: await hashPassword(PASSWORD),
      role: 'administrator',
      forcePasswordChange: false,
    });

    for (let i = 0; i < LOCKOUT_POLICY.maxFailuresPerIdentifier; i += 1) {
      await login(service, 'wrong-password');
    }

    // Same IP, different identifier — still under the per-IP allowance.
    const result = await login(service, PASSWORD, 'second@example.com');
    expect(result.ok).toBe(true);

    db.close();
  });
});

describe('AuthService.validateSession', () => {
  it('accepts a fresh token and rejects an unknown one', async () => {
    const { db, service } = await setUp();
    const result = await login(service, PASSWORD);
    if (!result.ok) throw new Error('login should have succeeded');

    expect(service.validateSession(result.token).valid).toBe(true);
    expect(service.validateSession('not-a-real-token')).toEqual({
      valid: false,
      reason: 'unknown',
    });

    db.close();
  });

  it('stops authenticating immediately after logout — the reason server-side sessions exist', async () => {
    const { db, service, admins } = await setUp();
    const result = await login(service, PASSWORD);
    if (!result.ok) throw new Error('login should have succeeded');
    const admin = admins.findByEmail(EMAIL)!;

    service.logout(result.session, admin, IP, null);

    expect(service.validateSession(result.token)).toEqual({ valid: false, reason: 'revoked' });

    db.close();
  });

  it('rejects a session whose absolute expiry has passed', async () => {
    const { db, service } = await setUp();
    const result = await login(service, PASSWORD);
    if (!result.ok) throw new Error('login should have succeeded');

    db.run('UPDATE sessions SET expires_at = ? WHERE id = ?', [
      new Date(Date.now() - 1000).toISOString(),
      result.session.id,
    ]);

    expect(service.validateSession(result.token)).toEqual({ valid: false, reason: 'expired' });

    db.close();
  });

  it('rejects a session idle beyond the idle window even though its absolute expiry is far away', async () => {
    const { db, service } = await setUp();
    const result = await login(service, PASSWORD);
    if (!result.ok) throw new Error('login should have succeeded');

    db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [
      new Date(Date.now() - 48 * 3_600_000).toISOString(),
      result.session.id,
    ]);

    expect(service.validateSession(result.token)).toEqual({ valid: false, reason: 'idle' });

    db.close();
  });

  it('drops a live session the moment its administrator is disabled', async () => {
    const { db, service, admins } = await setUp();
    const result = await login(service, PASSWORD);
    if (!result.ok) throw new Error('login should have succeeded');

    admins.update(result.session.adminId, { disabled: true });

    expect(service.validateSession(result.token)).toEqual({
      valid: false,
      reason: 'admin-unusable',
    });

    db.close();
  });
});

describe('AuthService.changePassword', () => {
  it('revokes every other session but keeps the one that made the change', async () => {
    const { db, service, admins } = await setUp();
    const first = await login(service, PASSWORD);
    const second = await login(service, PASSWORD);
    const third = await login(service, PASSWORD);
    if (!first.ok || !second.ok || !third.ok) throw new Error('logins should have succeeded');
    const admin = admins.findByEmail(EMAIL)!;

    const changed = await service.changePassword(
      admin,
      third.session,
      PASSWORD,
      'a-brand-new-password',
      IP,
      null,
    );
    expect(changed.ok).toBe(true);

    expect(service.validateSession(third.token).valid).toBe(true);
    expect(service.validateSession(first.token)).toEqual({ valid: false, reason: 'revoked' });
    expect(service.validateSession(second.token)).toEqual({ valid: false, reason: 'revoked' });

    db.close();
  });

  it('refuses when the current password is wrong, and leaves the stored hash untouched', async () => {
    const { db, service, admins } = await setUp();
    const result = await login(service, PASSWORD);
    if (!result.ok) throw new Error('login should have succeeded');
    const admin = admins.findByEmail(EMAIL)!;

    const changed = await service.changePassword(
      admin,
      result.session,
      'not-the-current-password',
      'a-brand-new-password',
      IP,
      null,
    );
    expect(changed).toEqual({ ok: false });
    expect(admins.findByEmail(EMAIL)?.passwordHash).toBe(admin.passwordHash);

    db.close();
  });

  it('lets the new password log in and refuses the old one', async () => {
    const { db, service, admins } = await setUp();
    const result = await login(service, PASSWORD);
    if (!result.ok) throw new Error('login should have succeeded');
    const admin = admins.findByEmail(EMAIL)!;

    await service.changePassword(admin, result.session, PASSWORD, 'a-brand-new-password', IP, null);

    expect((await login(service, 'a-brand-new-password')).ok).toBe(true);
    expect((await login(service, PASSWORD)).ok).toBe(false);

    db.close();
  });
});

describe('AuthService audit trail', () => {
  it('never records a submitted password anywhere in the audit log', async () => {
    const { db, service } = await setUp();
    const sentinel = 'SENTINEL-p4ssw0rd-must-not-be-logged';

    await login(service, sentinel);
    await login(service, sentinel, 'nobody@example.com');
    await login(service, PASSWORD);

    const rows = db.all<Record<string, unknown>>('SELECT * FROM audit_log');
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(sentinel);

    db.close();
  });

  it('records failures and successes distinctly, so the distinction lives server-side only', async () => {
    const { db, service } = await setUp();

    await login(service, 'wrong-password');
    await login(service, PASSWORD);

    const actions = db
      .all<{ action: string }>('SELECT action FROM audit_log ORDER BY occurred_at')
      .map((row) => row.action);

    expect(actions).toContain('auth.login.failure');
    expect(actions).toContain('auth.login.success');

    db.close();
  });
});
