import { describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { CSRF_HEADER_NAME } from '@dwg/shared';
import { buildApp } from '../../app.js';
import { createDatabase, type Database } from '../../platform/db.js';
import { migrations, runMigrations } from '../../platform/migrations/index.js';
import { loadConfig, type AppConfig } from '../../platform/config.js';
import { createLogger } from '../../platform/logger.js';
import { AdminsRepository } from './admins.repository.js';
import { hashPassword } from './password.js';
import { SESSION_COOKIE_NAME } from './auth.middleware.js';

const EMAIL = 'admin@example.com';
const PASSWORD = 'correct-horse-battery-staple';

/** A `Sec-Fetch-Site` value real browsers send on a same-origin fetch/XHR — the header `requireCsrf` checks first. */
const SAME_ORIGIN_HEADERS = { 'sec-fetch-site': 'same-origin' };

function testLogger() {
  return createLogger({ level: 'silent' });
}

interface Harness {
  readonly db: Database;
  readonly app: FastifyInstance;
  readonly config: AppConfig;
}

interface SetUpOptions {
  readonly env?: Record<string, string>;
  readonly forcePasswordChange?: boolean;
  readonly email?: string;
  readonly password?: string;
}

async function setUp(options: SetUpOptions = {}): Promise<Harness> {
  const db = createDatabase(':memory:');
  runMigrations(db, migrations);
  const admins = new AdminsRepository(db);
  admins.create({
    email: options.email ?? EMAIL,
    passwordHash: await hashPassword(options.password ?? PASSWORD),
    role: 'administrator',
    forcePasswordChange: options.forcePasswordChange ?? false,
  });

  const config = loadConfig({ ...options.env });
  const app = await buildApp({ config, logger: testLogger(), db });
  return { db, app, config };
}

function login(
  app: FastifyInstance,
  overrides: { email?: string; password?: string } = {},
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: overrides.email ?? EMAIL, password: overrides.password ?? PASSWORD },
  });
}

function sessionCookieFrom(response: LightMyRequestResponse) {
  return response.cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAME);
}

/** Logs in and returns the raw session token plus the CSRF token fetched with it — the pair most CSRF-gated tests need. */
async function loginAndGetTokens(
  app: FastifyInstance,
  overrides: { email?: string; password?: string } = {},
): Promise<{ token: string; csrfToken: string }> {
  const loginResponse = await login(app, overrides);
  const cookie = sessionCookieFrom(loginResponse);
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

describe('POST /api/v1/auth/login — cookie flags', () => {
  it('sets a session cookie with HttpOnly, SameSite=Strict, Path=/ and Secure when COOKIE_SECURE=true', async () => {
    const { app, config } = await setUp({ env: { COOKIE_SECURE: 'true' } });

    const response = await login(app);

    expect(response.statusCode).toBe(200);
    const cookie = sessionCookieFrom(response);
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite?.toLowerCase()).toBe('strict');
    expect(cookie?.path).toBe('/');
    expect(cookie?.secure).toBe(true);
    expect(cookie?.maxAge).toBe(Math.round(config.session.absoluteTtlHours * 3_600));

    await app.close();
  });

  it('omits Secure when COOKIE_SECURE=false — Secure follows config, not a hardcoded default', async () => {
    const { app } = await setUp({ env: { COOKIE_SECURE: 'false' } });

    const response = await login(app);

    const cookie = sessionCookieFrom(response);
    expect(cookie?.secure).toBeFalsy();

    await app.close();
  });
});

describe('POST /api/v1/auth/login — uniform failure', () => {
  it('returns the same status and body shape for an unknown address and a wrong password', async () => {
    const { app } = await setUp();

    const unknown = await login(app, { email: 'nobody@example.com' });
    const wrong = await login(app, { password: 'not-the-password' });

    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);

    const unknownBody = unknown.json();
    const wrongBody = wrong.json();
    expect(unknownBody.error.code).toBe('INVALID_CREDENTIALS');
    expect(wrongBody.error.code).toBe('INVALID_CREDENTIALS');
    expect(unknownBody.error.message).toBe(wrongBody.error.message);
    expect(unknownBody.error.details).toBe(null);
    expect(wrongBody.error.details).toBe(null);

    // No session cookie on failure, either way.
    expect(sessionCookieFrom(unknown)).toBeUndefined();
    expect(sessionCookieFrom(wrong)).toBeUndefined();

    await app.close();
  });

  it('does not branch the response on why the login service refused it', async () => {
    const { app } = await setUp({ forcePasswordChange: true });

    // Correct password, but this scenario would also refuse for a
    // disabled account or a locked-out identifier — the point is that all
    // of those look identical to a wrong password from the HTTP layer.
    const wrong = await login(app, { password: 'not-the-password' });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('INVALID_CREDENTIALS');

    await app.close();
  });

  it('rate-limits rapid login attempts as defence in depth alongside the service-level lockout', async () => {
    const { app } = await setUp();

    for (let i = 0; i < 20; i += 1) {
      await login(app, { password: 'wrong-password' });
    }
    const limited = await login(app, { password: 'wrong-password' });

    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('RATE_LIMITED');

    await app.close();
  }, 20_000);
});

describe('requireSession', () => {
  it('rejects a request with no session cookie at all', async () => {
    const { app } = await setUp();

    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/session' });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHENTICATED');

    await app.close();
  });

  it('rejects a garbage cookie value and clears it', async () => {
    const { app } = await setUp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      cookies: { [SESSION_COOKIE_NAME]: 'not-a-real-token' },
    });

    expect(response.statusCode).toBe(401);
    const cleared = sessionCookieFrom(response);
    expect(cleared).toBeDefined();
    expect(cleared?.value).toBe('');

    await app.close();
  });

  it('rejects a revoked (logged-out) session token', async () => {
    const { app } = await setUp();
    const { token, csrfToken } = await loginAndGetTokens(app);

    const logoutResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookies: { [SESSION_COOKIE_NAME]: token },
      headers: { ...SAME_ORIGIN_HEADERS, [CSRF_HEADER_NAME]: csrfToken },
    });
    expect(logoutResponse.statusCode).toBe(200);

    const replay = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe('UNAUTHENTICATED');

    await app.close();
  });

  it('accepts a fresh session and returns the admin plus expiry', async () => {
    const { app } = await setUp();
    const loginResponse = await login(app);
    const cookie = sessionCookieFrom(loginResponse);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      cookies: { [SESSION_COOKIE_NAME]: cookie!.value },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.admin.email).toBe(EMAIL);
    expect(typeof body.expiresAt).toBe('string');

    await app.close();
  });
});

describe('requireCsrf', () => {
  it('rejects a state-changing request with no CSRF header', async () => {
    const { app } = await setUp();
    const { token } = await loginAndGetTokens(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookies: { [SESSION_COOKIE_NAME]: token },
      headers: { ...SAME_ORIGIN_HEADERS },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');

    await app.close();
  });

  it('rejects a state-changing request with the wrong CSRF token', async () => {
    const { app } = await setUp();
    const { token } = await loginAndGetTokens(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookies: { [SESSION_COOKIE_NAME]: token },
      headers: { ...SAME_ORIGIN_HEADERS, [CSRF_HEADER_NAME]: 'definitely-the-wrong-token' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');

    await app.close();
  });

  it('rejects a state-changing request from a foreign Origin, even with the correct token', async () => {
    const { app } = await setUp();
    const { token, csrfToken } = await loginAndGetTokens(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookies: { [SESSION_COOKIE_NAME]: token },
      // No sec-fetch-site here on purpose, so the Origin fallback path is
      // what's under test.
      headers: { origin: 'http://evil.example.com', [CSRF_HEADER_NAME]: csrfToken },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');

    await app.close();
  });

  it('accepts a same-origin request with the correct token', async () => {
    const { app } = await setUp();
    const { token, csrfToken } = await loginAndGetTokens(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookies: { [SESSION_COOKIE_NAME]: token },
      headers: { ...SAME_ORIGIN_HEADERS, [CSRF_HEADER_NAME]: csrfToken },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ loggedOut: true });

    await app.close();
  });

  it('also accepts same-origin evidence via a matching Origin header (no Sec-Fetch-Site)', async () => {
    const { app } = await setUp();
    const { token, csrfToken } = await loginAndGetTokens(app);

    // light-my-request defaults the Host header to localhost:80 for a
    // path-only injected URL.
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookies: { [SESSION_COOKIE_NAME]: token },
      headers: { origin: 'http://localhost:80', [CSRF_HEADER_NAME]: csrfToken },
    });

    expect(response.statusCode).toBe(200);

    await app.close();
  });

  it('does not gate safe methods: GET routes work with no CSRF header at all', async () => {
    const { app } = await setUp();
    const { token } = await loginAndGetTokens(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(200);

    await app.close();
  });
});

describe('POST /api/v1/auth/change-password', () => {
  it('refuses when the current password is wrong', async () => {
    const { app } = await setUp();
    const { token, csrfToken } = await loginAndGetTokens(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      cookies: { [SESSION_COOKIE_NAME]: token },
      headers: { ...SAME_ORIGIN_HEADERS, [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        currentPassword: 'not-the-current-password',
        newPassword: 'a-brand-new-password!',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('INVALID_CREDENTIALS');

    await app.close();
  });

  it('changes the password and the new one works on the next login', async () => {
    const { app } = await setUp();
    const { token, csrfToken } = await loginAndGetTokens(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      cookies: { [SESSION_COOKIE_NAME]: token },
      headers: { ...SAME_ORIGIN_HEADERS, [CSRF_HEADER_NAME]: csrfToken },
      payload: { currentPassword: PASSWORD, newPassword: 'a-brand-new-password!' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().admin.forcePasswordChange).toBe(false);

    const oldLogin = await login(app);
    expect(oldLogin.statusCode).toBe(401);

    const newLogin = await login(app, { password: 'a-brand-new-password!' });
    expect(newLogin.statusCode).toBe(200);

    await app.close();
  });
});

describe('forcePasswordChange gating', () => {
  it('blocks GET /session but allows csrf-token, change-password and logout', async () => {
    const { app } = await setUp({ forcePasswordChange: true });
    const loginResponse = await login(app);
    expect(loginResponse.json().admin.forcePasswordChange).toBe(true);
    const token = sessionCookieFrom(loginResponse)!.value;

    const sessionAttempt = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(sessionAttempt.statusCode).toBe(403);
    expect(sessionAttempt.json().error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const csrfAttempt = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/csrf-token',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(csrfAttempt.statusCode).toBe(200);
    const csrfToken = (csrfAttempt.json() as { csrfToken: string }).csrfToken;

    const changeAttempt = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      cookies: { [SESSION_COOKIE_NAME]: token },
      headers: { ...SAME_ORIGIN_HEADERS, [CSRF_HEADER_NAME]: csrfToken },
      payload: { currentPassword: PASSWORD, newPassword: 'a-brand-new-password!' },
    });
    expect(changeAttempt.statusCode).toBe(200);
    expect(changeAttempt.json().admin.forcePasswordChange).toBe(false);

    await app.close();
  });

  it('allows logout even while a password change is pending', async () => {
    const { app } = await setUp({ forcePasswordChange: true });
    const loginResponse = await login(app);
    const token = sessionCookieFrom(loginResponse)!.value;

    const csrfAttempt = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/csrf-token',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    const csrfToken = (csrfAttempt.json() as { csrfToken: string }).csrfToken;

    const logoutAttempt = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookies: { [SESSION_COOKIE_NAME]: token },
      headers: { ...SAME_ORIGIN_HEADERS, [CSRF_HEADER_NAME]: csrfToken },
    });
    expect(logoutAttempt.statusCode).toBe(200);

    await app.close();
  });
});
