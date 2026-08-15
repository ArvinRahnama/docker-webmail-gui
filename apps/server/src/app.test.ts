import { describe, expect, it } from 'vitest';
import { HealthResponseSchema } from '@dwg/shared';
import { buildApp } from './app.js';
import { loadConfig } from './platform/config.js';
import { createLogger } from './platform/logger.js';

function testLogger() {
  return createLogger({ level: 'silent' });
}

describe('GET /api/v1/health', () => {
  it('returns a schema-conforming, "ok" health response', async () => {
    const app = await buildApp({ config: loadConfig({}), logger: testLogger() });

    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(response.statusCode).toBe(200);
    const body: unknown = response.json();
    const result = HealthResponseSchema.safeParse(body);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('ok');
      expect(result.data.uptime).toBeGreaterThanOrEqual(0);
      expect(result.data.version.length).toBeGreaterThan(0);
    }
    await app.close();
  });

  it('reflects a request id back on the response', async () => {
    const app = await buildApp({ config: loadConfig({}), logger: testLogger() });

    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(response.headers['request-id']).toBeTruthy();
    await app.close();
  });

  it('sets the documented baseline security headers', async () => {
    const app = await buildApp({ config: loadConfig({}), logger: testLogger() });

    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['permissions-policy']).toBeTruthy();
    await app.close();
  });
});

describe('unmatched routes', () => {
  it('returns the uniform error envelope, not a bare Fastify 404 body', async () => {
    const app = await buildApp({ config: loadConfig({}), logger: testLogger() });

    const response = await app.inject({ method: 'GET', url: '/api/v1/this-route-does-not-exist' });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(typeof body.error.errorId).toBe('string');
    await app.close();
  });
});
