import { describe, expect, it } from 'vitest';
import { FakeBrokerClient } from '../../drivers/broker/fake-broker-client.js';
import { FIXTURE_CONTAINER_INSPECT_STOPPED } from '../../drivers/broker/fixtures/index.js';
import {
  authedInject,
  loginAs,
  setUpBackupsApp,
  waitForJobToFinish,
} from './backups-test-harness.js';

const FIXTURE_IMAGE = 'ghcr.io/docker-mailserver/docker-mailserver:latest';

async function createBackup(
  app: Awaited<ReturnType<typeof setUpBackupsApp>>['app'],
  auth: { token: string; csrfToken: string },
  mode: 'warm' | 'cold' = 'warm',
) {
  const response = await authedInject(app, auth, {
    method: 'POST',
    url: '/api/v1/backups',
    payload: { mode },
  });
  expect(response.statusCode).toBe(200);
  const { jobId } = response.json() as { jobId: string };
  const finished = await waitForJobToFinish(app, auth, jobId);
  expect(finished.status).toBe('succeeded');
  return jobId;
}

describe('/api/v1/backups', () => {
  it('requires authentication', async () => {
    const { app } = await setUpBackupsApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/backups' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('creates a backup via a job, then lists and fetches its detail', async () => {
    const { app, db } = await setUpBackupsApp();
    const auth = await loginAs(app);
    await createBackup(app, auth, 'warm');

    const listResponse = await authedInject(app, auth, { method: 'GET', url: '/api/v1/backups' });
    expect(listResponse.statusCode).toBe(200);
    const list = listResponse.json() as {
      backups: { id: string; mode: string; verificationStatus: string }[];
    };
    expect(list.backups).toHaveLength(1);
    expect(list.backups[0]?.mode).toBe('warm');
    expect(list.backups[0]?.verificationStatus).toBe('unverified');

    const id = list.backups[0]!.id;
    const detailResponse = await authedInject(app, auth, {
      method: 'GET',
      url: `/api/v1/backups/${id}`,
    });
    expect(detailResponse.statusCode).toBe(200);
    const detail = detailResponse.json() as { manifest: { volumes: unknown[] } };
    expect(detail.manifest.volumes).toHaveLength(4);

    const rows = db.all<{ action: string }>(
      "SELECT action FROM audit_log WHERE action = 'backup.create'",
    );
    expect(rows).toHaveLength(1);
    await app.close();
  });

  it('verify succeeds on a freshly created backup and updates verificationStatus', async () => {
    const { app } = await setUpBackupsApp();
    const auth = await loginAs(app);
    await createBackup(app, auth);

    const list = (
      await authedInject(app, auth, { method: 'GET', url: '/api/v1/backups' })
    ).json() as { backups: { id: string }[] };
    const id = list.backups[0]!.id;

    const verifyResponse = await authedInject(app, auth, {
      method: 'POST',
      url: `/api/v1/backups/${id}/verify`,
    });
    expect(verifyResponse.statusCode).toBe(200);
    const { jobId } = verifyResponse.json() as { jobId: string };
    const finished = await waitForJobToFinish(app, auth, jobId);
    expect(finished.status).toBe('succeeded');

    const detail = (
      await authedInject(app, auth, { method: 'GET', url: `/api/v1/backups/${id}` })
    ).json() as { backup: { verificationStatus: string; verifiedAt: string | null } };
    expect(detail.backup.verificationStatus).toBe('verified');
    expect(detail.backup.verifiedAt).not.toBeNull();
    await app.close();
  });

  it('downloads the archive with the right content type and byte-identical body', async () => {
    const { app } = await setUpBackupsApp();
    const auth = await loginAs(app);
    await createBackup(app, auth);

    const list = (
      await authedInject(app, auth, { method: 'GET', url: '/api/v1/backups' })
    ).json() as { backups: { id: string }[] };
    const id = list.backups[0]!.id;

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: `/api/v1/backups/${id}/download`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/x-tar');
    expect(response.headers['content-disposition']).toContain(`${id}.tar`);
    expect(response.rawPayload.length).toBeGreaterThan(0);
    await app.close();
  });

  it('deletes a backup and audits it', async () => {
    const { app, db } = await setUpBackupsApp();
    const auth = await loginAs(app);
    await createBackup(app, auth);

    const list = (
      await authedInject(app, auth, { method: 'GET', url: '/api/v1/backups' })
    ).json() as { backups: { id: string }[] };
    const id = list.backups[0]!.id;

    const deleteResponse = await authedInject(app, auth, {
      method: 'DELETE',
      url: `/api/v1/backups/${id}`,
    });
    expect(deleteResponse.statusCode).toBe(200);

    const afterList = (
      await authedInject(app, auth, { method: 'GET', url: '/api/v1/backups' })
    ).json() as { backups: unknown[] };
    expect(afterList.backups).toHaveLength(0);

    const rows = db.all<{ action: string }>(
      "SELECT action FROM audit_log WHERE action = 'backup.delete'",
    );
    expect(rows).toHaveLength(1);
    await app.close();
  });
});

describe('POST /api/v1/backups/:id/restore — Tier 4 refusals', () => {
  it('refuses without confirm: true', async () => {
    const { app } = await setUpBackupsApp();
    const auth = await loginAs(app);
    await createBackup(app, auth);
    const id = (
      (await authedInject(app, auth, { method: 'GET', url: '/api/v1/backups' })).json() as {
        backups: { id: string }[];
      }
    ).backups[0]!.id;

    const response = await authedInject(app, auth, {
      method: 'POST',
      url: `/api/v1/backups/${id}/restore`,
      payload: { acknowledgeNoRecentBackup: true },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
    await app.close();
  });

  it('refuses while the managed container is running', async () => {
    const broker = new FakeBrokerClient(); // running: true by default
    const { app } = await setUpBackupsApp({ brokerClient: broker });
    const auth = await loginAs(app);
    await createBackup(app, auth);
    const id = (
      (await authedInject(app, auth, { method: 'GET', url: '/api/v1/backups' })).json() as {
        backups: { id: string }[];
      }
    ).backups[0]!.id;

    const preflight = (
      await authedInject(app, auth, {
        method: 'GET',
        url: `/api/v1/backups/${id}/restore/preflight`,
      })
    ).json() as { containerRunning: boolean };
    expect(preflight.containerRunning).toBe(true);

    const response = await authedInject(app, auth, {
      method: 'POST',
      url: `/api/v1/backups/${id}/restore`,
      payload: { confirm: true, acknowledgeNoRecentBackup: true },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CONFLICT');
    await app.close();
  });

  it('refuses on manifest/image digest mismatch, container stopped', async () => {
    let reportedImage = FIXTURE_IMAGE;
    const broker = Object.assign(new FakeBrokerClient(), {
      containerInspect: async () => ({
        ...FIXTURE_CONTAINER_INSPECT_STOPPED,
        image: reportedImage,
      }),
    });
    const { app } = await setUpBackupsApp({ brokerClient: broker });
    const auth = await loginAs(app);
    await createBackup(app, auth); // manifest.dmsImageDigest = FIXTURE_IMAGE

    reportedImage = 'ghcr.io/docker-mailserver/docker-mailserver:a-different-digest';

    const id = (
      (await authedInject(app, auth, { method: 'GET', url: '/api/v1/backups' })).json() as {
        backups: { id: string }[];
      }
    ).backups[0]!.id;

    const preflight = (
      await authedInject(app, auth, {
        method: 'GET',
        url: `/api/v1/backups/${id}/restore/preflight`,
      })
    ).json() as {
      containerRunning: boolean;
      manifestCompatible: boolean;
      compatibilityMessage: string | null;
    };
    expect(preflight.containerRunning).toBe(false);
    expect(preflight.manifestCompatible).toBe(false);
    expect(preflight.compatibilityMessage).toBeTruthy();

    const response = await authedInject(app, auth, {
      method: 'POST',
      url: `/api/v1/backups/${id}/restore`,
      payload: { confirm: true, acknowledgeNoRecentBackup: true },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CONFLICT');
    await app.close();
  });

  it('refuses without acknowledging the missing-recent-verified-backup gate', async () => {
    const broker = Object.assign(new FakeBrokerClient(), {
      containerInspect: async () => FIXTURE_CONTAINER_INSPECT_STOPPED,
    });
    const { app } = await setUpBackupsApp({ brokerClient: broker });
    const auth = await loginAs(app);
    await createBackup(app, auth); // no verified backup exists yet

    const id = (
      (await authedInject(app, auth, { method: 'GET', url: '/api/v1/backups' })).json() as {
        backups: { id: string }[];
      }
    ).backups[0]!.id;

    const response = await authedInject(app, auth, {
      method: 'POST',
      url: `/api/v1/backups/${id}/restore`,
      payload: { confirm: true, acknowledgeNoRecentBackup: false },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('succeeds when stopped, digest matches, and the backup gate is acknowledged', async () => {
    const broker = Object.assign(new FakeBrokerClient(), {
      containerInspect: async () => FIXTURE_CONTAINER_INSPECT_STOPPED,
    });
    const { app, db } = await setUpBackupsApp({ brokerClient: broker });
    const auth = await loginAs(app);
    await createBackup(app, auth);

    const id = (
      (await authedInject(app, auth, { method: 'GET', url: '/api/v1/backups' })).json() as {
        backups: { id: string }[];
      }
    ).backups[0]!.id;

    const response = await authedInject(app, auth, {
      method: 'POST',
      url: `/api/v1/backups/${id}/restore`,
      payload: { confirm: true, acknowledgeNoRecentBackup: true },
    });
    expect(response.statusCode).toBe(200);
    const { jobId } = response.json() as { jobId: string };
    const finished = await waitForJobToFinish(app, auth, jobId);
    expect(finished.status).toBe('succeeded');

    const rows = db.all<{ action: string }>(
      "SELECT action FROM audit_log WHERE action = 'backup.restore'",
    );
    expect(rows).toHaveLength(1);
    await app.close();
  });
});
