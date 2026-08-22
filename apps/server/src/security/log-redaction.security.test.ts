/**
 * SECURITY.md Part 5 check 8: "Log redaction — secrets never appear in
 * output."
 *
 * `platform/logger.test.ts` already proves the redaction *mechanism* in
 * isolation: feed `createLogger()` a hand-built object shaped like a
 * request/response, and the sensitive keys come out censored. What it
 * cannot prove is that the *real app*, driven by *real HTTP requests*,
 * only ever logs through that mechanism — a handler that logged
 * `logger.info({ password })` with a differently-spelled key, or that
 * interpolated a secret straight into a message string (bypassing
 * structured redaction entirely, since fast-redact only ever inspects
 * object fields), would sail past every one of `logger.test.ts`'s
 * assertions while still leaking in production.
 *
 * This file closes that gap end-to-end: boots the real app with a real
 * (non-silent, debug-level) logger writing to an in-memory sink, drives
 * a handful of requests that carry a real password or session token
 * through the system — a correct login, a wrong-password login, a
 * password change, and an authenticated request generally — and asserts
 * the *raw captured log text* never contains any of those literal
 * secret values, however they might have been logged.
 *
 * Worth being precise about what this proves versus what it does not:
 * as this app is built today, Fastify's default request/response
 * serializers (no custom one is configured in `app.ts`) log only
 * `{method, url, host, remoteAddress}` / `{statusCode}` — headers and
 * bodies never reach a log line at all, so the redact list has nothing
 * to censor in this exact sequence and never visibly fires (that
 * mechanism-level proof stays `logger.test.ts`'s job, feeding the
 * redactor a hand-built object that *does* contain a sensitive key).
 * What this file proves is the thing check 8 actually asks for: across
 * a realistic secret-carrying request sequence, nothing in the real
 * app's real log output is any of those literal secrets — which would
 * catch a future handler that logged one directly (`logger.info({
 * password })`, or a secret spliced into a message string, which
 * `fast-redact`'s object-path redaction cannot reach at all) exactly as
 * surely as it would catch a regression in the serializer configuration
 * itself.
 */
import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { CSRF_HEADER_NAME } from '@dwg/shared';
import { buildApp } from '../app.js';
import { createDatabase } from '../platform/db.js';
import { migrations, runMigrations } from '../platform/migrations/index.js';
import { loadConfig } from '../platform/config.js';
import { REDACTION_PATHS } from '../platform/logger.js';
import { AdminsRepository } from '../modules/auth/admins.repository.js';
import { hashPassword } from '../modules/auth/password.js';
import { SESSION_COOKIE_NAME } from '../modules/auth/auth.middleware.js';

const EMAIL = 'log-redaction-admin@example.com';
const CORRECT_PASSWORD = 'correct-horse-battery-staple-99';
const WRONG_PASSWORD = 'definitely-the-wrong-password-77';
const NEW_PASSWORD = 'a-brand-new-rotated-password-42';

/** Captures every chunk pino writes, verbatim — the same sink shape `createLogger`'s own doc comment documents tests using. */
class CapturingSink {
  private chunks: string[] = [];
  write(chunk: string): void {
    this.chunks.push(chunk);
  }
  text(): string {
    return this.chunks.join('');
  }
}

async function bootAppWithRealLogging(sink: CapturingSink) {
  const db = createDatabase(':memory:');
  runMigrations(db, migrations);
  const admins = new AdminsRepository(db);
  admins.create({
    email: EMAIL,
    passwordHash: await hashPassword(CORRECT_PASSWORD),
    role: 'administrator',
    forcePasswordChange: false,
  });

  const logger = pino(
    {
      name: '@dwg/server-test',
      level: 'debug',
      redact: { paths: [...REDACTION_PATHS], censor: '[REDACTED]' },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    sink,
  );

  const config = loadConfig({});
  const app = await buildApp({ config, logger, db });
  return app;
}

describe('the real app never logs a real secret value, across a representative request sequence', () => {
  it('login (success and failure), change-password, and an authenticated request all leave the raw log text clean', async () => {
    const sink = new CapturingSink();
    const app = await bootAppWithRealLogging(sink);
    try {
      // 1. A wrong-password login attempt — the credential is submitted,
      // rejected, and (per AuthService's own audit trail test) must never
      // be recorded anywhere, including an incidental request/response log.
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: EMAIL, password: WRONG_PASSWORD },
      });

      // 2. A correct login — establishes the session this test drives the
      // rest of the sequence through.
      const loginResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: EMAIL, password: CORRECT_PASSWORD },
      });
      const sessionCookie = loginResponse.cookies.find((c) => c.name === SESSION_COOKIE_NAME);
      expect(sessionCookie).toBeDefined();
      const token = sessionCookie!.value;

      // 3. An authenticated read — exercises ordinary request logging
      // (method/url/headers, including the Cookie header itself) with a
      // real, live session token in play.
      await app.inject({
        method: 'GET',
        url: '/api/v1/auth/session',
        cookies: { [SESSION_COOKIE_NAME]: token },
      });

      // 4. A password change — both the current and new password values
      // pass through the request body in the same call.
      const csrfResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/csrf-token',
        cookies: { [SESSION_COOKIE_NAME]: token },
      });
      const csrfToken = (csrfResponse.json() as { csrfToken: string }).csrfToken;

      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/change-password',
        cookies: { [SESSION_COOKIE_NAME]: token },
        headers: { 'sec-fetch-site': 'same-origin', [CSRF_HEADER_NAME]: csrfToken },
        payload: { currentPassword: CORRECT_PASSWORD, newPassword: NEW_PASSWORD },
      });

      const logText = sink.text();
      expect(logText.length).toBeGreaterThan(0); // sanity: something was actually logged

      // The CSRF synchroniser token is deliberately not asserted on here:
      // it is not in `logger.ts`'s `SENSITIVE_KEYS` and is not a secret
      // under this project's own threat model (SECURITY.md §3.6) — its
      // job is unpredictability to a cross-site caller, not
      // confidentiality from an operator's own logs. Asserting its
      // absence would test a property this codebase never promised.
      for (const secret of [CORRECT_PASSWORD, WRONG_PASSWORD, NEW_PASSWORD, token]) {
        expect(logText).not.toContain(secret);
      }
    } finally {
      await app.close();
    }
  });
});
