/**
 * Shared HTTP test harness for the M10 backups/restore route tests,
 * mirroring `modules/jobs/jobs-test-harness.ts` exactly — same login/
 * CSRF/inject dance, extended with a `backupDir` override so each test
 * gets its own throwaway directory rather than writing into `./backups`.
 * Not matched by vitest's `*.test.ts` glob, so this is purely an internal
 * helper, never collected as its own suite.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { CSRF_HEADER_NAME } from '@dwg/shared';
import { buildApp, type BuildAppOptions } from '../../app.js';
import { createDatabase, type Database } from '../../platform/db.js';
import { migrations, runMigrations } from '../../platform/migrations/index.js';
import { loadConfig } from '../../platform/config.js';
import { createLogger } from '../../platform/logger.js';
import { AdminsRepository } from '../auth/admins.repository.js';
import { hashPassword } from '../auth/password.js';
import { SESSION_COOKIE_NAME } from '../auth/auth.middleware.js';

export const PRIMARY_EMAIL = 'backups-admin@example.com';
export const PRIMARY_PASSWORD = 'correct-horse-battery-staple';
export const SAME_ORIGIN_HEADERS = { 'sec-fetch-site': 'same-origin' };

export function testLogger() {
  return createLogger({ level: 'silent' });
}

export interface BackupsHarness {
  readonly db: Database;
  readonly app: FastifyInstance;
  readonly backupDir: string;
}

export type BackupsAppOverrides = Omit<BuildAppOptions, 'config' | 'logger' | 'db'>;

/** Boots a real app (real DB, real migrations, real auth, a fresh temp `BACKUP_DIR`) with one enabled administrator, over caller-supplied overrides. */
export async function setUpBackupsApp(
  overrides: BackupsAppOverrides = {},
): Promise<BackupsHarness> {
  const db = createDatabase(':memory:');
  runMigrations(db, migrations);
  const admins = new AdminsRepository(db);
  admins.create({
    email: PRIMARY_EMAIL,
    passwordHash: await hashPassword(PRIMARY_PASSWORD),
    role: 'administrator',
    forcePasswordChange: false,
  });

  const backupDir = mkdtempSync(join(tmpdir(), 'dwg-backups-route-test-'));
  const config = loadConfig({ BACKUP_DIR: backupDir });
  const app = await buildApp({ config, logger: testLogger(), db, ...overrides });
  return { db, app, backupDir };
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

/** Polls `GET /api/v1/jobs/:id` until it leaves `queued`/`running` — the job runner is in-process and fast for fixture-sized fake archives, so a short bounded poll (never a fixed sleep) is all tests need. */
export async function waitForJobToFinish(
  app: FastifyInstance,
  auth: { token: string; csrfToken: string },
  jobId: string,
): Promise<{ status: string; errorMessage: string | null }> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const response = await authedInject(app, auth, { method: 'GET', url: `/api/v1/jobs/${jobId}` });
    const body = response.json() as { job: { status: string; errorMessage: string | null } };
    if (body.job.status !== 'queued' && body.job.status !== 'running') {
      return body.job;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Job ${jobId} did not finish within the test timeout (stuck at ${body.job.status}).`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
