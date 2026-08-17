import { describe, expect, it } from 'vitest';
import { NetworkListResponseSchema } from '@dwg/shared';
import { authedInject, loginAs, setUpDockerApp } from './docker-test-harness.js';

describe('/api/v1/docker/networks', () => {
  it('requires authentication', async () => {
    const { app } = await setUpDockerApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/docker/networks' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('lists networks, read-only', async () => {
    const { app } = await setUpDockerApp();
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/docker/networks',
    });
    expect(response.statusCode).toBe(200);
    expect(NetworkListResponseSchema.safeParse(response.json()).success).toBe(true);
    await app.close();
  });

  it('has no mutating route in this module', async () => {
    const { app } = await setUpDockerApp();
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, {
      method: 'DELETE',
      url: '/api/v1/docker/networks/anything',
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
