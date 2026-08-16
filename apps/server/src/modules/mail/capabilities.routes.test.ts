import { describe, expect, it } from 'vitest';
import { FakeDmsDriver } from '../../drivers/dms/index.js';
import { authedInject, loginAs, setUpMailApp } from './mail-test-harness.js';

describe('GET /api/v1/mail/capabilities — the document every UnsupportedNotice reads from', () => {
  it('returns the same capability document the driver would report directly', async () => {
    const { app } = await setUpMailApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/mail/capabilities',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const expected = await new FakeDmsDriver().getCapabilities();
    expect(body).toEqual(expected);
  });

  it('rejects the request with no session at all', async () => {
    const { app } = await setUpMailApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/mail/capabilities' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});
