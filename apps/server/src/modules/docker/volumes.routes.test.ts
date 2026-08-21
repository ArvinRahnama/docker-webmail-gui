import { describe, expect, it } from 'vitest';
import { DockerVolumeListResponseSchema } from '@dwg/shared';
import { BrokerRequestError } from '../../drivers/broker/index.js';
import { authedInject, loginAs, setUpDockerApp, stubBrokerClient } from './docker-test-harness.js';

describe('/api/v1/docker/volumes', () => {
  it('requires authentication', async () => {
    const { app } = await setUpDockerApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/docker/volumes' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('lists volumes with isProtected computed from the managed container mounts', async () => {
    const { app } = await setUpDockerApp();
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/docker/volumes',
    });
    expect(response.statusCode).toBe(200);
    const parsed = DockerVolumeListResponseSchema.safeParse(response.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const mailData = parsed.data.volumes.find((v) => v.name === 'dms-mail-data');
      const scratch = parsed.data.volumes.find((v) => v.name === 'dms-scratch');
      expect(mailData?.isProtected).toBe(true);
      expect(scratch?.isProtected).toBe(false);
    }
    await app.close();
  });

  // ---------------------------------------------------------------------
  // The control FEATURE_MATRIX.md §25 requires: "Deletion of a volume
  // holding mail data is blocked outright, not merely confirmed" — so this
  // asserts the refusal itself, never a confirmation prompt.
  // ---------------------------------------------------------------------

  it('refuses to remove a volume backing a protected DMS data mount', async () => {
    const { app } = await setUpDockerApp();
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, {
      method: 'DELETE',
      url: '/api/v1/docker/volumes/dms-mail-data',
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
    await app.close();
  });

  it('removes an unprotected volume', async () => {
    let removedName: string | undefined;
    const { app } = await setUpDockerApp({
      brokerClient: stubBrokerClient({
        volumeRemove: async (name) => {
          removedName = name;
        },
      }),
    });
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, {
      method: 'DELETE',
      url: '/api/v1/docker/volumes/dms-scratch',
    });
    expect(response.statusCode).toBe(200);
    expect(removedName).toBe('dms-scratch');
    await app.close();
  });

  it('surfaces any broker-side refusal as FORBIDDEN, not a silent success', async () => {
    const { app } = await setUpDockerApp({
      brokerClient: stubBrokerClient({
        volumeRemove: async () => {
          throw new BrokerRequestError(403, 'This volume backs a protected mail-data mount.');
        },
      }),
    });
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, {
      method: 'DELETE',
      url: '/api/v1/docker/volumes/anything',
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
    await app.close();
  });

  it('records an audit event for a successful removal', async () => {
    const { app, db } = await setUpDockerApp({
      brokerClient: stubBrokerClient({ volumeRemove: async () => {} }),
    });
    const auth = await loginAs(app);
    await authedInject(app, auth, {
      method: 'DELETE',
      url: '/api/v1/docker/volumes/dms-scratch',
    });
    const rows = db.all<{ action: string; target: string }>(
      "SELECT action, target FROM audit_log WHERE action = 'volume.remove'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.target).toBe('volume:dms-scratch');
    await app.close();
  });
});
