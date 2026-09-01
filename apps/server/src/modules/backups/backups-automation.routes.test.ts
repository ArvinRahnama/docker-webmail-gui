import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  BackupDestinationStatusResponse,
  BackupDestinationSecretResponse,
  BackupDetailResponse,
  BackupJobAck,
  BackupListResponse,
  BackupScheduleResponse,
  RemoteBackupListResponse,
} from '@dwg/shared';
import {
  authedInject,
  loginAs,
  setUpBackupsApp,
  waitForJobToFinish,
  type BackupsHarness,
} from './backups-test-harness.js';
import { startFakeS3, type FakeS3 } from './destinations/fake-s3-server.js';

const SECRET = 'super-secret-access-key';
let fake: FakeS3;

// Long timer intervals so the background scheduler/reconciler never fire during a test.
const NO_TIMERS = { backupSchedulerIntervalMs: 3_600_000, backupReconcileIntervalMs: 3_600_000 };

beforeEach(async () => {
  fake = await startFakeS3();
});
afterEach(async () => {
  await fake.close();
});

type Auth = { token: string; csrfToken: string };

function configureS3(app: BackupsHarness['app'], auth: Auth) {
  return authedInject(app, auth, {
    method: 'PUT',
    url: '/api/v1/backups/destination',
    payload: {
      type: 's3',
      endpoint: `http://127.0.0.1:${fake.port}`,
      region: 'us-east-1',
      bucket: 'backups-bucket',
      prefix: 'backups',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: SECRET,
    },
  });
}

async function createBackup(app: BackupsHarness['app'], auth: Auth): Promise<string> {
  const ack = (
    await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/backups',
      payload: { mode: 'warm' },
    })
  ).json() as BackupJobAck;
  const finished = await waitForJobToFinish(app, auth, ack.jobId);
  expect(finished.status).toBe('succeeded');
  const list = (
    await authedInject(app, auth, { method: 'GET', url: '/api/v1/backups' })
  ).json() as BackupListResponse;
  return list.backups[0]!.id;
}

describe('backups automation routes — schedule', () => {
  it('requires authentication', async () => {
    const { app } = await setUpBackupsApp(NO_TIMERS);
    const response = await app.inject({ method: 'GET', url: '/api/v1/backups/schedule' });
    expect(response.statusCode).toBe(401);
  });

  it('defaults to off and can be updated', async () => {
    const { app } = await setUpBackupsApp(NO_TIMERS);
    const auth = await loginAs(app);

    const before = (
      await authedInject(app, auth, { method: 'GET', url: '/api/v1/backups/schedule' })
    ).json() as BackupScheduleResponse;
    expect(before.schedule).toMatchObject({ frequency: 'off', enabled: false, nextRunAt: null });

    const updated = (
      await authedInject(app, auth, {
        method: 'PUT',
        url: '/api/v1/backups/schedule',
        payload: {
          frequency: 'daily',
          mode: 'warm',
          retentionKeep: 3,
          retentionMaxAgeDays: null,
          uploadToRemote: true,
        },
      })
    ).json() as BackupScheduleResponse;
    expect(updated.schedule.enabled).toBe(true);
    expect(updated.schedule.nextRunAt).not.toBeNull();
  });
});

describe('backups automation routes — destination', () => {
  it('configures S3, masks the secret in status, tests the connection, and reveals only on demand', async () => {
    const { app } = await setUpBackupsApp(NO_TIMERS);
    const auth = await loginAs(app);

    const putResponse = await configureS3(app, auth);
    expect(putResponse.statusCode).toBe(200);
    // The masked status must never carry the secret.
    expect(putResponse.body).not.toContain(SECRET);

    const status = (
      await authedInject(app, auth, { method: 'GET', url: '/api/v1/backups/destination' })
    ).json() as BackupDestinationStatusResponse;
    expect(status.destination).toMatchObject({
      type: 's3',
      configured: true,
      describe: 's3://backups-bucket/backups',
      s3: { accessKeyId: 'AKIAEXAMPLE', secretAccessKeySet: true },
    });

    const test = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/backups/destination/test',
    });
    expect(test.statusCode).toBe(200);

    const revealed = (
      await authedInject(app, auth, {
        method: 'POST',
        url: '/api/v1/backups/destination/reveal-secret',
      })
    ).json() as BackupDestinationSecretResponse;
    expect(revealed.value).toBe(SECRET);
  });
});

describe('backups automation routes — remote round-trip', () => {
  it('uploads a backup, reclaims local, browses the remote, and imports it back', async () => {
    const { app } = await setUpBackupsApp(NO_TIMERS);
    const auth = await loginAs(app);
    await configureS3(app, auth);

    const backupId = await createBackup(app, auth);

    // Upload to remote.
    const uploadAck = (
      await authedInject(app, auth, {
        method: 'POST',
        url: `/api/v1/backups/${backupId}/upload`,
      })
    ).json() as BackupJobAck;
    expect((await waitForJobToFinish(app, auth, uploadAck.jobId)).status).toBe('succeeded');

    // Uploaded + local reclaimed.
    let detail = (
      await authedInject(app, auth, { method: 'GET', url: `/api/v1/backups/${backupId}` })
    ).json() as BackupDetailResponse;
    expect(detail.backup.uploadStatus).toBe('uploaded');
    expect(detail.backup.localPresent).toBe(false);

    // Browse the remote — the backup is there, no longer local.
    const remote = (
      await authedInject(app, auth, { method: 'GET', url: '/api/v1/backups/remote' })
    ).json() as RemoteBackupListResponse;
    expect(remote.backups.map((b) => b.backupId)).toContain(backupId);
    expect(remote.backups.find((b) => b.backupId === backupId)?.alreadyLocal).toBe(false);

    // Import it back and verify it lands local again.
    const importAck = (
      await authedInject(app, auth, {
        method: 'POST',
        url: '/api/v1/backups/remote/import',
        payload: { backupId },
      })
    ).json() as BackupJobAck;
    expect((await waitForJobToFinish(app, auth, importAck.jobId)).status).toBe('succeeded');

    detail = (
      await authedInject(app, auth, { method: 'GET', url: `/api/v1/backups/${backupId}` })
    ).json() as BackupDetailResponse;
    expect(detail.backup.localPresent).toBe(true);
  });

  it('browsing the remote with no destination configured is refused', async () => {
    const { app } = await setUpBackupsApp(NO_TIMERS);
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/backups/remote',
    });
    expect(response.statusCode).toBe(409);
  });

  it('rejects an import with a path-traversal backup id at the schema boundary', async () => {
    const { app } = await setUpBackupsApp(NO_TIMERS);
    const auth = await loginAs(app);
    await configureS3(app, auth);
    const response = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/backups/remote/import',
      payload: { backupId: '../../etc/passwd' },
    });
    expect(response.statusCode).toBe(400);
  });
});
