import { describe, expect, it } from 'vitest';
import { ConsoleAvailabilityResponseSchema, ConsoleExecResponseSchema } from '@dwg/shared';
import { authedInject, loginAs, setUpDockerApp, stubBrokerClient } from './docker-test-harness.js';

describe('/api/v1/docker/console — off by default', () => {
  it('requires authentication', async () => {
    const { app } = await setUpDockerApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/docker/console' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('reports the console as unsupported when ENABLE_EXEC_CONSOLE is unset', async () => {
    const { app } = await setUpDockerApp();
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/docker/console',
    });
    expect(response.statusCode).toBe(200);
    const parsed = ConsoleAvailabilityResponseSchema.safeParse(response.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.capability.supported).toBe(false);
    }
    await app.close();
  });

  it('rejects any exec attempt while disabled, without ever calling the broker', async () => {
    let called = false;
    const { app } = await setUpDockerApp({
      brokerClient: stubBrokerClient({
        consoleExec: async (command) => {
          called = true;
          throw new Error(`should never be called (got ${command})`);
        },
      }),
    });
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/docker/console/exec',
      payload: { command: 'postqueue-p' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CAPABILITY_UNSUPPORTED');
    expect(called).toBe(false);
    await app.close();
  });
});

describe('/api/v1/docker/console — enabled', () => {
  it('reports supported and runs an allowlisted command', async () => {
    const { app } = await setUpDockerApp({}, { ENABLE_EXEC_CONSOLE: 'true' });
    const auth = await loginAs(app);

    const availability = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/docker/console',
    });
    expect(availability.json().capability.supported).toBe(true);

    const execResponse = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/docker/console/exec',
      payload: { command: 'postqueue-p' },
    });
    expect(execResponse.statusCode).toBe(200);
    const parsed = ConsoleExecResponseSchema.safeParse(execResponse.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.argv).toEqual(['postqueue', '-p']);
    }
    await app.close();
  });

  // -----------------------------------------------------------------
  // The behaviour the milestone brief calls out by name: the console
  // "rejects any command outside the enum."
  // -----------------------------------------------------------------

  it('rejects a command outside the fixed enum', async () => {
    let called = false;
    const { app } = await setUpDockerApp(
      {
        brokerClient: stubBrokerClient({
          consoleExec: async () => {
            called = true;
            throw new Error('unreachable');
          },
        }),
      },
      { ENABLE_EXEC_CONSOLE: 'true' },
    );
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/docker/console/exec',
      payload: { command: 'rm-rf' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
    expect(called).toBe(false);
    await app.close();
  });

  it('rejects an argv array in place of a symbolic command key', async () => {
    const { app } = await setUpDockerApp({}, { ENABLE_EXEC_CONSOLE: 'true' });
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/docker/console/exec',
      payload: { argv: ['rm', '-rf', '/'] },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('records an audit event for a successful command', async () => {
    const { app, db } = await setUpDockerApp({}, { ENABLE_EXEC_CONSOLE: 'true' });
    const auth = await loginAs(app);
    await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/docker/console/exec',
      payload: { command: 'doveadm-who' },
    });
    const rows = db.all<{ action: string; target: string }>(
      "SELECT action, target FROM audit_log WHERE action = 'console.exec'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.target).toBe('console-command:doveadm-who');
    await app.close();
  });
});
