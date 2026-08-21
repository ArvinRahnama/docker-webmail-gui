import { describe, expect, it } from 'vitest';
import { LogsFileResponseSchema } from '@dwg/shared';
import { authedInject, loginAs, setUpDockerApp, stubBrokerClient } from './docker-test-harness.js';

describe('/api/v1/docker/logs/file/:source', () => {
  it('requires authentication', async () => {
    const { app } = await setUpDockerApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/docker/logs/file/mail',
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('reads the mail source', async () => {
    const { app } = await setUpDockerApp();
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/docker/logs/file/mail',
    });
    expect(response.statusCode).toBe(200);
    const parsed = LogsFileResponseSchema.safeParse(response.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.lines.length).toBeGreaterThan(0);
    }
    await app.close();
  });

  it('reads the fail2ban source', async () => {
    const { app } = await setUpDockerApp();
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/docker/logs/file/fail2ban',
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  // ---------------------------------------------------------------------
  // The control AGENT_BRIEF.md §3 rule 4 requires: "Log sources and
  // editable files are server-side enums." A source outside the enum,
  // traversal attempts included, is rejected by this route's own
  // validation, before `LogsService`/the broker are ever reached —
  // asserted by a spy that must never be called.
  // ---------------------------------------------------------------------

  it('rejects any source outside the fixed enum, including path traversal, without ever calling the broker', async () => {
    let called = false;
    const { app } = await setUpDockerApp({
      brokerClient: stubBrokerClient({
        logsFile: async () => {
          called = true;
          return [];
        },
      }),
    });
    const auth = await loginAs(app);

    // Single-segment values that reach this route's own `:source` param
    // unmolested by URL/path normalisation, then get rejected by
    // `LogFileSourceSchema` — asserted precisely, including the exact
    // error code.
    for (const source of ['..-..-etc-passwd', 'etc-shadow', 'mail.log', 'MAIL', 'mail-fail2ban']) {
      const response = await authedInject(app, auth, {
        method: 'GET',
        url: `/api/v1/docker/logs/file/${source}`,
      });
      expect(response.statusCode, source).toBe(400);
      expect(response.json().error.code, source).toBe('VALIDATION_FAILED');
    }

    // Traversal-shaped values that a router/URL-normalisation step may
    // intercept *before* this route's handler ever runs — a bare `..`
    // segment collapses the path one level up, and `%2f`-encoded slashes
    // may split into extra segments. Either way the outcome must never be
    // "200 with file content"; whether that surfaces as this route's own
    // `400 VALIDATION_FAILED` or a `404` from no route matching is not
    // the property under test here — only that content is never returned.
    for (const traversal of ['..', '../../etc/passwd', '..%2f..%2f..%2fetc%2fpasswd']) {
      const response = await authedInject(app, auth, {
        method: 'GET',
        url: `/api/v1/docker/logs/file/${traversal}`,
      });
      expect(response.statusCode, traversal).not.toBe(200);
    }

    expect(called).toBe(false);
    await app.close();
  });

  it('rejects an out-of-bounds tail value', async () => {
    const { app } = await setUpDockerApp();
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/docker/logs/file/mail?tail=999999',
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

describe('/api/v1/docker/logs/container', () => {
  it('decodes container stdout/stderr', async () => {
    const { app } = await setUpDockerApp();
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/docker/logs/container',
    });
    expect(response.statusCode).toBe(200);
    expect(Array.isArray(response.json().lines)).toBe(true);
    await app.close();
  });
});
