import { describe, expect, it } from 'vitest';
import { createDatabase } from '../platform/db.js';
import { migrations, runMigrations } from '../platform/migrations/index.js';
import { loadConfig } from '../platform/config.js';
import { AdminsRepository } from '../modules/auth/admins.repository.js';
import { LoginAttemptsRepository } from '../modules/auth/login-attempts.repository.js';
import { SessionsRepository } from '../modules/auth/sessions.repository.js';
import { AuthService, LOCKOUT_POLICY } from '../modules/auth/auth.service.js';
import { hashPassword } from '../modules/auth/password.js';
import {
  ResetAdminError,
  generateRecoveryPassword,
  resetAdminPassword,
} from './reset-admin-password.js';

const EMAIL = 'admin@example.com';

function setUp() {
  const db = createDatabase(':memory:');
  runMigrations(db, migrations);
  const admins = new AdminsRepository(db);
  const sessions = new SessionsRepository(db);
  const attempts = new LoginAttemptsRepository(db);
  const service = new AuthService({ db, admins, sessions, attempts, config: loadConfig({}) });
  return { db, admins, attempts, service };
}

const login = (service: AuthService, password: string) =>
  service.login({ email: EMAIL, password, ipAddress: '203.0.113.5', userAgent: null });

describe('resetAdminPassword', () => {
  it('lets a locked-out, disabled administrator straight back in with the printed password', async () => {
    const { db, admins, service } = setUp();
    const admin = admins.create({
      email: EMAIL,
      passwordHash: await hashPassword('forgotten-password-123'),
      role: 'administrator',
      forcePasswordChange: false,
    });
    admins.update(admin.id, { disabled: true });
    for (let i = 0; i < LOCKOUT_POLICY.maxFailuresPerIdentifier; i += 1) {
      await login(service, 'wrong-guess');
    }

    const outcome = await resetAdminPassword(db, ' Admin@Example.com ');
    expect(outcome.action).toBe('reset');

    const result = await login(service, outcome.password);
    expect(result.ok).toBe(true);
    expect(result.ok && result.admin.forcePasswordChange).toBe(true);
    expect(
      db.all("SELECT * FROM audit_log WHERE action = 'admin.password_reset_cli'"),
    ).toHaveLength(1);
    db.close();
  });

  it('creates the administrator when bootstrap never created one', async () => {
    const { db, service } = setUp();
    const outcome = await resetAdminPassword(db, EMAIL);
    expect(outcome.action).toBe('created');
    expect((await login(service, outcome.password)).ok).toBe(true);
    db.close();
  });

  it('refuses an unknown address when administrators exist, naming them', async () => {
    const { db, admins } = setUp();
    admins.create({
      email: EMAIL,
      passwordHash: await hashPassword('some-password-123'),
      role: 'administrator',
      forcePasswordChange: false,
    });
    await expect(resetAdminPassword(db, 'other@example.com')).rejects.toThrow(
      new ResetAdminError(
        `No administrator named other@example.com. Existing administrators: ${EMAIL}.`,
      ),
    );
    db.close();
  });

  it('generates passwords free of shell and .env metacharacters', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateRecoveryPassword()).toMatch(/^[A-Za-z0-9_-]{24}$/);
    }
  });
});
