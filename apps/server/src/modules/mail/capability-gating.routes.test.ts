/**
 * HTTP-level confirmation that capability gating is real end-to-end —
 * not just at `capability-guards.ts`'s own unit level
 * (`mailboxes.service.test.ts`). `buildApp`'s `dmsDriver` override
 * (`app.ts`) lets a test hand in a `FakeDmsDriver` whose capability
 * document is deliberately wrong for its fixture data, so a mutating
 * request can be proven to fail with `CAPABILITY_UNSUPPORTED` — never an
 * obscure 500, never a silent no-op success — purely from what
 * `getCapabilities()` reports, regardless of what the underlying files
 * would otherwise allow.
 */
import { describe, expect, it } from 'vitest';
import type { DmsCapabilities } from '../../drivers/dms/capabilities.js';
import { FakeDmsDriver } from '../../drivers/dms/fake-dms-driver.js';
import { buildApp } from '../../app.js';
import { createDatabase } from '../../platform/db.js';
import { migrations, runMigrations } from '../../platform/migrations/index.js';
import { loadConfig } from '../../platform/config.js';
import { AdminsRepository } from '../auth/admins.repository.js';
import { hashPassword } from '../auth/password.js';
import {
  authedInject,
  loginAs,
  PRIMARY_EMAIL,
  PRIMARY_PASSWORD,
  testLogger,
} from './mail-test-harness.js';

const SUPPORTED: DmsCapabilities = {
  quotas: { supported: true, reason: null },
  rspamd: { supported: false, reason: null },
  clamav: { supported: false, reason: null },
  fail2ban: { supported: false, reason: null },
  accountProvisioner: 'FILE',
  localAccountManagement: { supported: true, reason: null },
};

/** A real `FakeDmsDriver` (real fixture data, real in-memory writes) whose `getCapabilities()` is overridden — see this file's own doc comment. */
class DriverWithCapabilities extends FakeDmsDriver {
  constructor(private readonly capabilities: DmsCapabilities) {
    super();
  }

  override async getCapabilities(): Promise<DmsCapabilities> {
    return this.capabilities;
  }
}

async function setUpWithCapabilities(capabilities: DmsCapabilities) {
  const db = createDatabase(':memory:');
  runMigrations(db, migrations);
  const admins = new AdminsRepository(db);
  admins.create({
    email: PRIMARY_EMAIL,
    passwordHash: await hashPassword(PRIMARY_PASSWORD),
    role: 'administrator',
    forcePasswordChange: false,
  });
  const app = await buildApp({
    config: loadConfig({}),
    logger: testLogger(),
    db,
    dmsDriver: new DriverWithCapabilities(capabilities),
  });
  return { app, db };
}

describe('quota mutations report CAPABILITY_UNSUPPORTED when ENABLE_QUOTAS is off', () => {
  it('PUT .../quota refuses before mutating anything', async () => {
    const { app } = await setUpWithCapabilities({
      ...SUPPORTED,
      quotas: {
        supported: false,
        reason: 'ENABLE_QUOTAS is not set (or is disabled) on this deployment.',
      },
    });
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'PUT',
      url: '/api/v1/mailboxes/admin@example.com/quota',
      payload: { quota: '1G' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CAPABILITY_UNSUPPORTED');
    expect(response.json().error.message).toContain('ENABLE_QUOTAS');

    // Confirm it is genuinely unmutated, not merely reporting failure —
    // GET/quota-report style verification: re-read the mailbox and it
    // still shows no quota change.
    const detail = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/mailboxes/admin@example.com',
    });
    expect(detail.json().mailbox.quota).not.toBe('1G');

    await app.close();
  });

  it('DELETE .../quota (clear) also refuses', async () => {
    const { app } = await setUpWithCapabilities({
      ...SUPPORTED,
      quotas: {
        supported: false,
        reason: 'ENABLE_QUOTAS is not set (or is disabled) on this deployment.',
      },
    });
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'DELETE',
      url: '/api/v1/mailboxes/admin@example.com/quota',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CAPABILITY_UNSUPPORTED');

    await app.close();
  });

  it('bulk quota also refuses as CAPABILITY_UNSUPPORTED, not a per-item failure list', async () => {
    const { app } = await setUpWithCapabilities({
      ...SUPPORTED,
      quotas: {
        supported: false,
        reason: 'ENABLE_QUOTAS is not set (or is disabled) on this deployment.',
      },
    });
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/mailboxes/bulk-quota',
      payload: { addresses: ['admin@example.com'], quota: '1G' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CAPABILITY_UNSUPPORTED');
    // Not the per-item {results:[...]} shape — the whole batch never ran.
    expect(response.json().results).toBeUndefined();

    await app.close();
  });
});

describe('mailbox/alias mutations report CAPABILITY_UNSUPPORTED under a non-FILE provisioner', () => {
  const ldapCapabilities: DmsCapabilities = {
    ...SUPPORTED,
    accountProvisioner: 'LDAP',
    localAccountManagement: {
      supported: false,
      reason:
        'ACCOUNT_PROVISIONER=LDAP — local mailbox/alias/quota management is unsupported because DMS never reads postfix-accounts.cf, postfix-virtual.cf or dovecot-quotas.cf under this provisioner.',
    },
  };

  it('POST /api/v1/mailboxes (create) refuses', async () => {
    const { app } = await setUpWithCapabilities(ldapCapabilities);
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/mailboxes',
      payload: { email: 'new@example.com', password: 'a-perfectly-good-password-123' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CAPABILITY_UNSUPPORTED');
    expect(response.json().error.message).toContain('LDAP');

    await app.close();
  });

  it('DELETE /api/v1/mailboxes/:address refuses, even with a valid mailData choice', async () => {
    const { app } = await setUpWithCapabilities(ldapCapabilities);
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'DELETE',
      url: '/api/v1/mailboxes/admin@example.com',
      payload: { mailData: 'keep' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CAPABILITY_UNSUPPORTED');

    await app.close();
  });

  it('POST /api/v1/aliases (create) refuses', async () => {
    const { app } = await setUpWithCapabilities(ldapCapabilities);
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/aliases',
      payload: { alias: 'new-alias@example.com', recipients: ['admin@example.com'] },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CAPABILITY_UNSUPPORTED');

    await app.close();
  });

  it('reads (GET) still work normally under LDAP — only writes are refused', async () => {
    const { app } = await setUpWithCapabilities(ldapCapabilities);
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, { method: 'GET', url: '/api/v1/mailboxes' });

    expect(response.statusCode).toBe(200);
    expect(response.json().total).toBeGreaterThan(0);

    await app.close();
  });
});
