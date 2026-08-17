import { describe, expect, it } from 'vitest';
import { MonitoringResponseSchema } from '@dwg/shared';
import { authedInject, loginAs, setUpDockerApp } from './docker-test-harness.js';

describe('/api/v1/docker/monitoring', () => {
  it('requires authentication', async () => {
    const { app } = await setUpDockerApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/docker/monitoring' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('combines container stats with host-level Docker system info in one snapshot', async () => {
    const { app } = await setUpDockerApp();
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/docker/monitoring',
    });
    expect(response.statusCode).toBe(200);
    const parsed = MonitoringResponseSchema.safeParse(response.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.stats.cpuPercent).toBeGreaterThanOrEqual(0);
      expect(parsed.data.system.serverVersion.length).toBeGreaterThan(0);
      expect(parsed.data.version.apiVersion.length).toBeGreaterThan(0);
      expect(parsed.data.df.imagesCount).toBeGreaterThanOrEqual(0);
    }
    await app.close();
  });
});
