/**
 * M13 — serving the built SPA from the same origin as the API
 * (ARCHITECTURE.md §4, §10; `.env.example`'s `PORT` comment;
 * `app.ts`'s `buildNotFoundHandler`). Only active when `config.staticDir`
 * is set — every other test in this codebase boots `buildApp()` without
 * it, so this file is the one place that behaviour is actually exercised
 * at all.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { loadConfig } from './platform/config.js';
import { createLogger } from './platform/logger.js';

function testLogger() {
  return createLogger({ level: 'silent' });
}

describe('static SPA serving (buildNotFoundHandler)', () => {
  let staticDir: string;

  beforeEach(() => {
    staticDir = mkdtempSync(join(tmpdir(), 'dwg-static-spa-test-'));
    writeFileSync(
      join(staticDir, 'index.html'),
      '<!doctype html><html><body>the SPA shell</body></html>',
    );
    mkdirSync(join(staticDir, 'assets'));
    writeFileSync(join(staticDir, 'assets', 'app.js'), 'console.log("real asset");');
  });

  afterEach(() => {
    rmSync(staticDir, { recursive: true, force: true });
  });

  it('does nothing when staticDir is unset — the default for every other test in this codebase', async () => {
    const app = await buildApp({ config: loadConfig({}), logger: testLogger() });
    try {
      const response = await app.inject({ method: 'GET', url: '/mail/domains' });
      // No static handler registered at all: an unmatched non-API route
      // still gets the plain JSON 404 envelope, not the SPA shell.
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('NOT_FOUND');
    } finally {
      await app.close();
    }
  });

  it('serves a real static asset by path', async () => {
    const app = await buildApp({
      config: loadConfig({ STATIC_DIR: staticDir }),
      logger: testLogger(),
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/assets/app.js' });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('real asset');
    } finally {
      await app.close();
    }
  });

  it('falls back to index.html for a client-side SPA route (no matching file on disk)', async () => {
    const app = await buildApp({
      config: loadConfig({ STATIC_DIR: staticDir }),
      logger: testLogger(),
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/mail/domains' });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('the SPA shell');
    } finally {
      await app.close();
    }
  });

  it('falls back to index.html for a deeply nested client-side route too', async () => {
    const app = await buildApp({
      config: loadConfig({ STATIC_DIR: staticDir }),
      logger: testLogger(),
    });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/mail/mailboxes/admin@example.com',
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('the SPA shell');
    } finally {
      await app.close();
    }
  });

  it('a genuinely unmatched /api/v1/* path still gets the JSON envelope, never the SPA shell', async () => {
    const app = await buildApp({
      config: loadConfig({ STATIC_DIR: staticDir }),
      logger: testLogger(),
    });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/this-route-does-not-exist',
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('NOT_FOUND');
      expect(response.body).not.toContain('the SPA shell');
    } finally {
      await app.close();
    }
  });

  it('a real API route (health) still works exactly as without static serving', async () => {
    const app = await buildApp({
      config: loadConfig({ STATIC_DIR: staticDir }),
      logger: testLogger(),
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe('ok');
    } finally {
      await app.close();
    }
  });

  it('an unmatched non-GET/HEAD request gets the JSON envelope, not an attempted file send', async () => {
    const app = await buildApp({
      config: loadConfig({ STATIC_DIR: staticDir }),
      logger: testLogger(),
    });
    try {
      const response = await app.inject({ method: 'POST', url: '/mail/domains' });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('NOT_FOUND');
    } finally {
      await app.close();
    }
  });

  it('carries the real security headers on the served SPA shell too — static serving is not a bypass', async () => {
    const app = await buildApp({
      config: loadConfig({ STATIC_DIR: staticDir }),
      logger: testLogger(),
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/mail/domains' });
      expect(response.headers['content-security-policy']).toBeTruthy();
      expect(response.headers['x-frame-options']).toBe('DENY');
    } finally {
      await app.close();
    }
  });
});
