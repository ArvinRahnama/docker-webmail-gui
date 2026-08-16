/**
 * Shared HTTP test harness for the M7 mail route test files
 * (`domains.routes.test.ts`, `mailboxes.routes.test.ts`,
 * `aliases.routes.test.ts`, `quotas.routes.test.ts`,
 * `capabilities.routes.test.ts`). Factored out because all five need the
 * identical login/CSRF/inject dance `admins.routes.test.ts` first wrote
 * inline — kept here, not exported from `@dwg/server`'s public surface
 * (there is none), and not matched by vitest's `*.test.ts` glob, so it is
 * purely an internal helper, never collected as its own suite.
 */
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { CSRF_HEADER_NAME } from '@dwg/shared';
import { buildApp } from '../../app.js';
import { createDatabase, type Database } from '../../platform/db.js';
import { migrations, runMigrations } from '../../platform/migrations/index.js';
import { loadConfig } from '../../platform/config.js';
import { createLogger } from '../../platform/logger.js';
import type { DmsDriver } from '../../drivers/dms/index.js';
import { AdminsRepository } from '../auth/admins.repository.js';
import { hashPassword } from '../auth/password.js';
import { SESSION_COOKIE_NAME } from '../auth/auth.middleware.js';

export const PRIMARY_EMAIL = 'mail-admin@example.com';
export const PRIMARY_PASSWORD = 'correct-horse-battery-staple';
export const SAME_ORIGIN_HEADERS = { 'sec-fetch-site': 'same-origin' };

export function testLogger() {
  return createLogger({ level: 'silent' });
}

export interface MailHarness {
  readonly db: Database;
  readonly app: FastifyInstance;
}

/** Boots a real app (real DB, real migrations, real auth) with one enabled administrator, over a caller-supplied or default-fake `DmsDriver`. */
export async function setUpMailApp(dmsDriver?: DmsDriver): Promise<MailHarness> {
  const db = createDatabase(':memory:');
  runMigrations(db, migrations);
  const admins = new AdminsRepository(db);
  admins.create({
    email: PRIMARY_EMAIL,
    passwordHash: await hashPassword(PRIMARY_PASSWORD),
    role: 'administrator',
    forcePasswordChange: false,
  });

  const config = loadConfig({});
  const app = await buildApp({
    config,
    logger: testLogger(),
    db,
    ...(dmsDriver !== undefined ? { dmsDriver } : {}),
  });
  return { db, app };
}

/** Logs in and returns everything a CSRF-gated mutating request needs. */
export async function loginAs(
  app: FastifyInstance,
  email: string = PRIMARY_EMAIL,
  password: string = PRIMARY_PASSWORD,
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

/** `app.inject()` with the cookie + CSRF header a mutating request needs already attached. */
export function authedInject(
  app: FastifyInstance,
  auth: { token: string; csrfToken: string },
  options: {
    method: string;
    url: string;
    payload?: Record<string, unknown> | readonly unknown[];
  },
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: options.method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: options.url,
    cookies: { [SESSION_COOKIE_NAME]: auth.token },
    headers: { ...SAME_ORIGIN_HEADERS, [CSRF_HEADER_NAME]: auth.csrfToken },
    ...(options.payload !== undefined ? { payload: options.payload } : {}),
  });
}
