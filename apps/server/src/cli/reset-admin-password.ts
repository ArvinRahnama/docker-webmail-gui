/**
 * Operator recovery: reset an administrator's password from the host.
 *
 *   docker exec dwg-server node apps/server/dist/cli/reset-admin-password.js admin@example.com
 *
 * The login page can only ever say "incorrect email or password" for an
 * account problem (auth.service.ts — by design it never says which), so an
 * operator who is told that with the password they believe is right had,
 * until now, no way back in short of a purge-and-reinstall. The usual
 * causes are all invisible from the browser: the password was changed and
 * forgotten; `BOOTSTRAP_ADMIN_PASSWORD` was edited in `.env` after the
 * first start (it is only ever applied once); or a `$` in it was swallowed
 * by Compose's `.env` interpolation, so the stored password was never the
 * one in the file.
 *
 * Running a command inside the server container already requires Docker
 * access on the host — root, in effect — so this tool asks for no further
 * proof. It:
 *
 *  - sets a fresh random password, which it prints once, and requires the
 *    administrator to change it at the next sign-in;
 *  - re-enables the account if it was disabled;
 *  - signs out every session the account had;
 *  - clears the brute-force lockout (every failed-attempt row — they exist
 *    only to drive the lockout; the audit log keeps the history);
 *  - when no administrator exists at all (bootstrap never succeeded),
 *    creates the named one instead.
 *
 * It is audited like every other credential change.
 */
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { NewPasswordSchema } from '@dwg/shared';
import { loadConfig } from '../platform/config.js';
import { openAppDatabase, type Database } from '../platform/db.js';
import { runMigrations, migrations } from '../platform/migrations/index.js';
import { recordAuditEvent } from '../platform/audit.js';
import { AdminsRepository, normalizeEmail } from '../modules/auth/admins.repository.js';
import { SessionsRepository } from '../modules/auth/sessions.repository.js';
import { hashPassword } from '../modules/auth/password.js';

export interface ResetOutcome {
  readonly action: 'reset' | 'created';
  readonly email: string;
  readonly password: string;
  readonly sessionsRevoked: number;
}

export class ResetAdminError extends Error {}

/** 24 URL-safe characters from 18 CSPRNG bytes — comfortably over the password policy's minimum, and free of characters a shell or `.env` would reinterpret. */
export function generateRecoveryPassword(): string {
  return randomBytes(18).toString('base64url');
}

export async function resetAdminPassword(
  db: Database,
  rawEmail: string,
  password: string = generateRecoveryPassword(),
): Promise<ResetOutcome> {
  const email = normalizeEmail(rawEmail);
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new ResetAdminError(`"${rawEmail}" is not an email address.`);
  }
  const policy = NewPasswordSchema.safeParse(password);
  if (!policy.success) {
    throw new ResetAdminError('The generated password does not meet the password policy.');
  }

  const admins = new AdminsRepository(db);
  const sessions = new SessionsRepository(db);
  const passwordHash = await hashPassword(password);
  const now = new Date().toISOString();

  const existing = admins.findByEmail(email);
  if (existing === undefined && admins.count() > 0) {
    const known = admins
      .list()
      .map((row) => row.email)
      .join(', ');
    throw new ResetAdminError(
      `No administrator named ${email}. Existing administrators: ${known}.`,
    );
  }

  return db.transaction(() => {
    let adminId: string;
    let sessionsRevoked = 0;
    let action: ResetOutcome['action'];

    if (existing === undefined) {
      const created = admins.create({
        email,
        passwordHash,
        role: 'administrator',
        forcePasswordChange: true,
      });
      adminId = created.id;
      action = 'created';
    } else {
      adminId = existing.id;
      admins.updatePassword(adminId, passwordHash);
      admins.update(adminId, { disabled: false });
      // updatePassword clears the change requirement (a real change
      // satisfies it); a password chosen by this tool is not that.
      db.run('UPDATE admins SET force_password_change = 1 WHERE id = ?', [adminId]);
      sessionsRevoked = sessions.revokeAllForAdmin(adminId, now);
      action = 'reset';
    }

    db.run('DELETE FROM login_attempts WHERE success = 0');

    recordAuditEvent(db, {
      actor: { adminId: null, label: 'cli:reset-admin-password' },
      action: 'admin.password_reset_cli',
      target: { type: 'admin', id: adminId },
      result: 'success',
      ip: null,
      userAgent: null,
      details: { email, created: action === 'created', sessionsRevoked },
    });

    return { action, email, password, sessionsRevoked };
  });
}

async function main(argv: readonly string[]): Promise<number> {
  const email = argv[0];
  if (email === undefined || email === '--help' || email === '-h' || argv.length > 1) {
    process.stderr.write(
      'Usage: node apps/server/dist/cli/reset-admin-password.js <administrator-email>\n' +
        'Sets a new random password (printed once), re-enables the account, signs out its\n' +
        'sessions and clears the sign-in lockout. Creates the administrator if none exists.\n',
    );
    return 2;
  }

  const config = loadConfig();
  const db = openAppDatabase(config.dataDir);
  try {
    runMigrations(db, migrations);
    const outcome = await resetAdminPassword(db, email);
    process.stdout.write(
      `${outcome.action === 'created' ? 'Created administrator' : 'Reset password for'} ${outcome.email}.\n` +
        `New password: ${outcome.password}\n` +
        `Sign in with it now; you will be asked to choose your own.` +
        (outcome.sessionsRevoked > 0
          ? ` ${outcome.sessionsRevoked} existing session(s) were signed out.`
          : '') +
        '\n',
    );
    return 0;
  } catch (err) {
    if (err instanceof ResetAdminError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  } finally {
    db.close();
  }
}

// Run only when executed directly, never when imported by a test.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
