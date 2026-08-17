import { describe, expect, it } from 'vitest';
import {
  ContainerInspectResponseSchema,
  ContainerListResponseSchema,
  OperationAckSchema,
} from '@dwg/shared';
import { authedInject, loginAs, setUpDockerApp, stubBrokerClient } from './docker-test-harness.js';

describe('/api/v1/docker/containers', () => {
  it('requires authentication', async () => {
    const { app } = await setUpDockerApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/docker/containers' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('lists every container, running or not', async () => {
    let receivedAll: boolean | undefined;
    const { app } = await setUpDockerApp({
      brokerClient: stubBrokerClient({
        containerList: async (params) => {
          receivedAll = params?.all;
          return [];
        },
      }),
    });
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/docker/containers',
    });
    expect(response.statusCode).toBe(200);
    expect(ContainerListResponseSchema.safeParse(response.json()).success).toBe(true);
    expect(receivedAll).toBe(true);
    await app.close();
  });

  it('inspects the managed container', async () => {
    const { app } = await setUpDockerApp();
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/docker/containers/managed',
    });
    expect(response.statusCode).toBe(200);
    expect(ContainerInspectResponseSchema.safeParse(response.json()).success).toBe(true);
    await app.close();
  });

  it.each([
    ['start', 'container.start'],
    ['stop', 'container.stop'],
    ['restart', 'container.restart'],
  ] as const)('%s is a mutation that requires CSRF and is audited', async (action, auditAction) => {
    const { app, db } = await setUpDockerApp();
    const auth = await loginAs(app);

    const noCsrf = await app.inject({
      method: 'POST',
      url: `/api/v1/docker/containers/managed/${action}`,
      cookies: { dwg_session: auth.token },
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    expect(noCsrf.statusCode).toBe(403);

    const response = await authedInject(app, auth, {
      method: 'POST',
      url: `/api/v1/docker/containers/managed/${action}`,
    });
    expect(response.statusCode).toBe(200);
    expect(OperationAckSchema.safeParse(response.json()).success).toBe(true);

    const rows = db.all<{ action: string }>('SELECT action FROM audit_log WHERE action = ?', [
      auditAction,
    ]);
    expect(rows).toHaveLength(1);
    await app.close();
  });
});
