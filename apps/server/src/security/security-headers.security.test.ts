/**
 * SECURITY.md Part 5 check 7, first half: "Security headers present."
 * (Second half — "the CSP not broken by the real app" — needs a real
 * browser against the real built SPA, which apps/server does not serve
 * yet (M13). That half lives in `e2e/security/csp.spec.ts`, tuned
 * against the Playwright harness once it exists — see that file's own
 * header for the current state of that half of this check.)
 *
 * `app.test.ts` already has one baseline assertion for this ("sets the
 * documented baseline security headers") using loose `toContain` checks.
 * This file is the exhaustive version: every directive SECURITY.md §4.2
 * lists, by name, checked against the *set* of directives Helmet
 * actually serialises (not a byte-exact string — Helmet does not put a
 * space after each `;`, SECURITY.md's prose does for readability, and
 * that whitespace carries no CSP semantics worth pinning); every other
 * documented header; and the one documented conditional behaviour
 * (`Strict-Transport-Security` follows `ENABLE_HSTS`, off by default only
 * for a plain-HTTP LAN install) actually toggling.
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../platform/config.js';
import { createLogger } from '../platform/logger.js';

function testLogger() {
  return createLogger({ level: 'silent' });
}

/** Every directive SECURITY.md §4.2 documents, as `[name, value]` pairs — order-independent, since CSP directive order carries no meaning. */
const EXPECTED_CSP_DIRECTIVES: ReadonlyArray<readonly [string, string]> = [
  ['default-src', "'self'"],
  ['script-src', "'self'"],
  ['style-src', "'self'"],
  ['img-src', "'self' data:"],
  ['font-src', "'self'"],
  ['connect-src', "'self'"],
  ['frame-ancestors', "'none'"],
  ['base-uri', "'none'"],
  ['form-action', "'self'"],
  ['object-src', "'none'"],
];

function parseCsp(header: string): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const [name, ...rest] = trimmed.split(' ');
    map.set(name!, rest.join(' '));
  }
  return map;
}

describe('security headers — every SECURITY.md §4.2 directive, on a real response', () => {
  it('CSP carries exactly the documented directive set, no more and no less, with no unsafe-inline/unsafe-eval/CDN anywhere', async () => {
    const app = await buildApp({ config: loadConfig({}), logger: testLogger() });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
      const header = response.headers['content-security-policy'];
      expect(typeof header).toBe('string');
      const directives = parseCsp(header as string);

      for (const [name, value] of EXPECTED_CSP_DIRECTIVES) {
        expect(directives.get(name)).toBe(value);
      }
      expect(directives.size).toBe(EXPECTED_CSP_DIRECTIVES.length);

      const raw = header as string;
      expect(raw).not.toContain('unsafe-inline');
      expect(raw).not.toContain('unsafe-eval');
      expect(raw).not.toMatch(/https?:\/\//); // no CDN/external origin anywhere in the policy
    } finally {
      await app.close();
    }
  });

  it('every other documented header is present with its documented value', async () => {
    const app = await buildApp({ config: loadConfig({}), logger: testLogger() });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.headers['x-frame-options']).toBe('DENY');
      const permissionsPolicy = response.headers['permissions-policy'] as string;
      for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb']) {
        expect(permissionsPolicy).toContain(`${feature}=()`);
      }
    } finally {
      await app.close();
    }
  });

  it('Strict-Transport-Security is present by default (ENABLE_HSTS defaults true)', async () => {
    const app = await buildApp({ config: loadConfig({}), logger: testLogger() });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
      expect(response.headers['strict-transport-security']).toContain('max-age=');
    } finally {
      await app.close();
    }
  });

  it('Strict-Transport-Security is absent when ENABLE_HSTS=false — the documented plain-HTTP-LAN opt-out (SECURITY.md §4.2)', async () => {
    const app = await buildApp({
      config: loadConfig({ ENABLE_HSTS: 'false' }),
      logger: testLogger(),
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
      expect(response.headers['strict-transport-security']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('headers appear on an error response too, not only the happy path', async () => {
    const app = await buildApp({ config: loadConfig({}), logger: testLogger() });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/this-route-does-not-exist',
      });
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-security-policy']).toBeTruthy();
      expect(response.headers['x-frame-options']).toBe('DENY');
    } finally {
      await app.close();
    }
  });
});
