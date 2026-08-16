import { describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { CSRF_HEADER_NAME } from '@dwg/shared';
import { buildApp } from '../../app.js';
import { createDatabase, type Database } from '../../platform/db.js';
import { migrations, runMigrations } from '../../platform/migrations/index.js';
import { loadConfig } from '../../platform/config.js';
import { createLogger } from '../../platform/logger.js';
import { AdminsRepository } from './admins.repository.js';
import { hashPassword } from './password.js';
import { SESSION_COOKIE_NAME } from './auth.middleware.js';
import { assertNotLastEnabledAdmin, assertNotSelf } from './admins.routes.js';

const PRIMARY_EMAIL = 'primary@example.com';
const PRIMARY_PASSWORD = 'correct-horse-battery-staple';
const SAME_ORIGIN_HEADERS = { 'sec-fetch-site': 'same-origin' };

function testLogger() {
  return createLogger({ level: 'silent' });
}

interface Harness {
  readonly db: Database;
  readonly app: FastifyInstance;
  readonly admins: AdminsRepository;
  readonly primaryId: string;
}

async function setUp(): Promise<Harness> {
  const db = createDatabase(':memory:');
  runMigrations(db, migrations);
  const admins = new AdminsRepository(db);
  const primary = admins.create({
    email: PRIMARY_EMAIL,
    passwordHash: await hashPassword(PRIMARY_PASSWORD),
    role: 'administrator',
    forcePasswordChange: false,
  });

  const config = loadConfig({});
  const app = await buildApp({ config, logger: testLogger(), db });
  return { db, app, admins, primaryId: primary.id };
}

/** Logs in and returns everything a CSRF-gated mutating request against /api/v1/admins needs. */
async function loginAs(
  app: FastifyInstance,
  email: string,
  password: string,
): Promise<{ token: string; csrfToken: string }> {
  const loginResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
  const cookie = loginResponse.cookies.find((c) => c.name === SESSION_COOKIE_NAME);
  if (cookie === undefined) throw new Error('login did not set a session cookie');
  const token = cookie.value;

  const csrfResponse = await app.inject({
    method: 'GET',
    url: '/api/v1/auth/csrf-token',
    cookies: { [SESSION_COOKIE_NAME]: token },
  });
  const csrfToken = (csrfResponse.json() as { csrfToken: string }).csrfToken;
  return { token, csrfToken };
}

/** `app.inject()` for /api/v1/admins with the cookie + CSRF header a mutating request needs already attached. */
function authedInject(
  app: FastifyInstance,
  auth: { token: string; csrfToken: string },
  options: { method: string; url: string; payload?: Record<string, unknown> },
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: options.method as 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: options.url,
    cookies: { [SESSION_COOKIE_NAME]: auth.token },
    headers: { ...SAME_ORIGIN_HEADERS, [CSRF_HEADER_NAME]: auth.csrfToken },
    ...(options.payload !== undefined ? { payload: options.payload } : {}),
  });
}

describe('POST /api/v1/admins — create', () => {
  it('creates a new administrator forced to change their password, and audits it', async () => {
    const { app, db } = await setUp();
    const auth = await loginAs(app, PRIMARY_EMAIL, PRIMARY_PASSWORD);

    const response = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/admins',
      payload: { email: 'new-admin@example.com', password: 'a-perfectly-good-password' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.admin.email).toBe('new-admin@example.com');
    expect(body.admin.forcePasswordChange).toBe(true);
    expect(body.admin.disabled).toBe(false);

    const audited = db
      .all<{ action: string }>('SELECT action FROM audit_log WHERE action = ?', ['admin.create'])
      .map((row) => row.action);
    expect(audited).toHaveLength(1);

    await app.close();
  });

  it('refuses a duplicate email with CONFLICT', async () => {
    const { app } = await setUp();
    const auth = await loginAs(app, PRIMARY_EMAIL, PRIMARY_PASSWORD);

    const response = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/admins',
      payload: { email: PRIMARY_EMAIL, password: 'a-perfectly-good-password' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CONFLICT');

    await app.close();
  });
});

describe('GET /api/v1/admins — list', () => {
  it('lists every administrator', async () => {
    const { app, admins } = await setUp();
    admins.create({
      email: 'second@example.com',
      passwordHash: await hashPassword('another-good-password'),
      role: 'administrator',
      forcePasswordChange: false,
    });
    const auth = await loginAs(app, PRIMARY_EMAIL, PRIMARY_PASSWORD);

    const response = await authedInject(app, auth, { method: 'GET', url: '/api/v1/admins' });

    expect(response.statusCode).toBe(200);
    const emails = response
      .json()
      .admins.map((a: { email: string }) => a.email)
      .sort();
    expect(emails).toEqual(['primary@example.com', 'second@example.com']);

    await app.close();
  });
});

describe('PATCH /api/v1/admins/:id — self-protection', () => {
  it('refuses to let an administrator disable their own account', async () => {
    const { app, admins, primaryId } = await setUp();
    admins.create({
      email: 'second@example.com',
      passwordHash: await hashPassword('another-good-password'),
      role: 'administrator',
      forcePasswordChange: false,
    });
    const auth = await loginAs(app, PRIMARY_EMAIL, PRIMARY_PASSWORD);

    const response = await authedInject(app, auth, {
      method: 'PATCH',
      url: `/api/v1/admins/${primaryId}`,
      payload: { disabled: true },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
    expect(admins.findById(primaryId)?.disabled).toBe(false);

    await app.close();
  });

  it('allows disabling a different administrator', async () => {
    const { app, admins } = await setUp();
    const second = admins.create({
      email: 'second@example.com',
      passwordHash: await hashPassword('another-good-password'),
      role: 'administrator',
      forcePasswordChange: false,
    });
    const auth = await loginAs(app, PRIMARY_EMAIL, PRIMARY_PASSWORD);

    const response = await authedInject(app, auth, {
      method: 'PATCH',
      url: `/api/v1/admins/${second.id}`,
      payload: { disabled: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().admin.disabled).toBe(true);
    expect(admins.findById(second.id)?.disabled).toBe(true);

    await app.close();
  });

  it('refuses to disable the last enabled administrator (here, coincident with self)', async () => {
    // With a single administrator in the system, the only administrator
    // able to authenticate and attempt this *is* that administrator — see
    // assertNotLastEnabledAdmin's doc comment in admins.routes.ts for why
    // this scenario and the self-protection one cannot be pulled apart
    // through the HTTP API. The end-to-end guarantee under test here is
    // "this system can never be left with zero enabled administrators."
    const { app, admins, primaryId } = await setUp();
    const auth = await loginAs(app, PRIMARY_EMAIL, PRIMARY_PASSWORD);

    const response = await authedInject(app, auth, {
      method: 'PATCH',
      url: `/api/v1/admins/${primaryId}`,
      payload: { disabled: true },
    });

    expect(response.statusCode).toBe(403);
    expect(admins.findById(primaryId)?.disabled).toBe(false);

    await app.close();
  });

  it('returns NOT_FOUND for an unknown administrator id', async () => {
    const { app } = await setUp();
    const auth = await loginAs(app, PRIMARY_EMAIL, PRIMARY_PASSWORD);

    const response = await authedInject(app, auth, {
      method: 'PATCH',
      url: '/api/v1/admins/adm_does_not_exist',
      payload: { disabled: true },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');

    await app.close();
  });
});

describe('DELETE /api/v1/admins/:id — self-protection', () => {
  it('refuses to let an administrator delete their own account', async () => {
    const { app, admins, primaryId } = await setUp();
    admins.create({
      email: 'second@example.com',
      passwordHash: await hashPassword('another-good-password'),
      role: 'administrator',
      forcePasswordChange: false,
    });
    const auth = await loginAs(app, PRIMARY_EMAIL, PRIMARY_PASSWORD);

    const response = await authedInject(app, auth, {
      method: 'DELETE',
      url: `/api/v1/admins/${primaryId}`,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
    expect(admins.findById(primaryId)).toBeDefined();

    await app.close();
  });

  it('deletes a different administrator and cascades their sessions', async () => {
    const { app, admins, db } = await setUp();
    const second = admins.create({
      email: 'second@example.com',
      passwordHash: await hashPassword('another-good-password'),
      role: 'administrator',
      forcePasswordChange: false,
    });
    // Give the second admin a live session, to prove it cascades away.
    await loginAs(app, 'second@example.com', 'another-good-password');
    const auth = await loginAs(app, PRIMARY_EMAIL, PRIMARY_PASSWORD);

    const response = await authedInject(app, auth, {
      method: 'DELETE',
      url: `/api/v1/admins/${second.id}`,
    });

    expect(response.statusCode).toBe(204);
    expect(admins.findById(second.id)).toBeUndefined();
    const remainingSessions = db.all<{ id: string }>('SELECT id FROM sessions WHERE admin_id = ?', [
      second.id,
    ]);
    expect(remainingSessions).toHaveLength(0);

    await app.close();
  });

  it('refuses to delete the last enabled administrator (here, coincident with self)', async () => {
    const { app, admins, primaryId } = await setUp();
    const auth = await loginAs(app, PRIMARY_EMAIL, PRIMARY_PASSWORD);

    const response = await authedInject(app, auth, {
      method: 'DELETE',
      url: `/api/v1/admins/${primaryId}`,
    });

    expect(response.statusCode).toBe(403);
    expect(admins.findById(primaryId)).toBeDefined();

    await app.close();
  });
});

describe('assertNotLastEnabledAdmin — boundary conditions (unit)', () => {
  it('throws CONFLICT when exactly one enabled administrator remains and the target is that one', async () => {
    const db = createDatabase(':memory:');
    runMigrations(db, migrations);
    const admins = new AdminsRepository(db);
    const only = admins.create({
      email: 'only@example.com',
      passwordHash: await hashPassword('a-good-password-here'),
      role: 'administrator',
      forcePasswordChange: false,
    });

    expect(() => assertNotLastEnabledAdmin(admins, only)).toThrow(/at least one/i);

    db.close();
  });

  it('does not throw when the target is already disabled, however few enabled administrators remain', async () => {
    const db = createDatabase(':memory:');
    runMigrations(db, migrations);
    const admins = new AdminsRepository(db);
    const solo = admins.create({
      email: 'solo@example.com',
      passwordHash: await hashPassword('a-good-password-here'),
      role: 'administrator',
      forcePasswordChange: false,
    });
    admins.update(solo.id, { disabled: true });
    const alreadyDisabled = admins.findById(solo.id)!;

    expect(() => assertNotLastEnabledAdmin(admins, alreadyDisabled)).not.toThrow();

    db.close();
  });

  it('does not throw when more than one administrator is enabled', async () => {
    const db = createDatabase(':memory:');
    runMigrations(db, migrations);
    const admins = new AdminsRepository(db);
    const first = admins.create({
      email: 'first@example.com',
      passwordHash: await hashPassword('a-good-password-here'),
      role: 'administrator',
      forcePasswordChange: false,
    });
    admins.create({
      email: 'second@example.com',
      passwordHash: await hashPassword('a-good-password-here'),
      role: 'administrator',
      forcePasswordChange: false,
    });

    expect(() => assertNotLastEnabledAdmin(admins, first)).not.toThrow();

    db.close();
  });
});

describe('assertNotSelf — unit', () => {
  it('throws FORBIDDEN when the actor and target are the same id', () => {
    expect(() => assertNotSelf('adm_1', 'adm_1', 'disable')).toThrow(/own administrator account/i);
  });

  it('does not throw when the actor and target differ', () => {
    expect(() => assertNotSelf('adm_1', 'adm_2', 'delete')).not.toThrow();
  });
});

describe('authorization is enforced server-side', () => {
  it('rejects every route with no session at all', async () => {
    const { app, primaryId } = await setUp();

    const requests: Array<{ method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; url: string }> = [
      { method: 'GET', url: '/api/v1/admins' },
      { method: 'POST', url: '/api/v1/admins' },
      { method: 'PATCH', url: `/api/v1/admins/${primaryId}` },
      { method: 'DELETE', url: `/api/v1/admins/${primaryId}` },
    ];

    for (const req of requests) {
      const response = await app.inject(req);
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('UNAUTHENTICATED');
    }

    await app.close();
  });

  it('rejects every route for a session whose stored role carries no admins:manage permission', async () => {
    const { app, db, admins } = await setUp();
    const outsider = admins.create({
      email: 'outsider@example.com',
      passwordHash: await hashPassword('a-good-password-here'),
      role: 'administrator',
      forcePasswordChange: false,
    });
    // No second role exists yet in the product (roles.ts), so the only way
    // to exercise "a session whose role genuinely lacks the permission" is
    // to write one directly at the storage layer — exactly what proves the
    // check is server-side and data-driven, not something a client could
    // ever assert about itself.
    db.run('UPDATE admins SET role = ? WHERE id = ?', ['guest', outsider.id]);

    const auth = await loginAs(app, 'outsider@example.com', 'a-good-password-here');

    const requests: Array<{ method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; url: string }> = [
      { method: 'GET', url: '/api/v1/admins' },
      { method: 'POST', url: '/api/v1/admins' },
      { method: 'PATCH', url: `/api/v1/admins/${outsider.id}` },
      { method: 'DELETE', url: `/api/v1/admins/${outsider.id}` },
    ];

    for (const req of requests) {
      const response = await authedInject(app, auth, req);
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('FORBIDDEN');
    }

    await app.close();
  });

  it('rejects a state-changing request missing its CSRF token even with a valid session', async () => {
    const { app } = await setUp();
    const auth = await loginAs(app, PRIMARY_EMAIL, PRIMARY_PASSWORD);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admins',
      cookies: { [SESSION_COOKIE_NAME]: auth.token },
      headers: { ...SAME_ORIGIN_HEADERS },
      payload: { email: 'new-admin@example.com', password: 'a-perfectly-good-password' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');

    await app.close();
  });
});
