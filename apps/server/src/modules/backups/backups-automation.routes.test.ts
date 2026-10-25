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

  it('stores the normalised S3 fields (bare host -> https://, blank region -> default, trimmed)', async () => {
    const { app } = await setUpBackupsApp(NO_TIMERS);
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'PUT',
      url: '/api/v1/backups/destination',
      payload: {
        type: 's3',
        endpoint: ' bucket.provider.example/ ',
        region: '',
        bucket: ' Mixed-Case ',
        prefix: ' backups ',
        accessKeyId: ' AKIAEXAMPLE ',
        secretAccessKey: SECRET,
      },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as BackupDestinationStatusResponse).destination).toMatchObject({
      describe: 's3://Mixed-Case/backups',
      s3: {
        endpoint: 'https://bucket.provider.example',
        region: 'us-east-1',
        bucket: 'Mixed-Case',
        prefix: 'backups',
        accessKeyId: 'AKIAEXAMPLE',
      },
    });
  });

  it('refuses an invalid region with a per-field VALIDATION_FAILED detail', async () => {
    const { app } = await setUpBackupsApp(NO_TIMERS);
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'PUT',
      url: '/api/v1/backups/destination',
      payload: {
        type: 's3',
        endpoint: 'bucket.provider.example',
        region: 'Tehran 3',
        bucket: 'bucket',
        prefix: '',
        accessKeyId: 'AKIAEXAMPLE',
        secretAccessKey: SECRET,
      },
    });
    expect(response.statusCode).toBe(400);
    const { error } = response.json() as {
      error: { code: string; details: { path: string; message: string }[] };
    };
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details).toEqual([
      { path: 'region', message: expect.stringMatching(/region code/) },
    ]);
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

  it('a second queued upload of a backup the first job already uploaded and reclaimed succeeds', async () => {
    const { app } = await setUpBackupsApp(NO_TIMERS);
    const auth = await loginAs(app);
    await configureS3(app, auth);
    const backupId = await createBackup(app, auth);

    // Both enqueued before either runs — the admin double-clicking "Upload to remote".
    const acks = await Promise.all(
      [1, 2].map(
        async () =>
          (
            await authedInject(app, auth, {
              method: 'POST',
              url: `/api/v1/backups/${backupId}/upload`,
            })
          ).json() as BackupJobAck,
      ),
    );
    for (const ack of acks) {
      const job = await waitForJobToFinish(app, auth, ack.jobId);
      expect(job.status).toBe('succeeded');
      expect(job.errorMessage).toBeNull();
    }

    const detail = (
      await authedInject(app, auth, { method: 'GET', url: `/api/v1/backups/${backupId}` })
    ).json() as BackupDetailResponse;
    expect(detail.backup.uploadStatus).toBe('uploaded');
    expect(detail.backup.localPresent).toBe(false);
  });

  it('fails the upload job with the remote error when the upload does not land', async () => {
    const { app } = await setUpBackupsApp(NO_TIMERS);
    const auth = await loginAs(app);
    await configureS3(app, auth);
    const backupId = await createBackup(app, auth);

    fake.errorResponse = { status: 403, code: 'AccessDenied' };
    try {
      const uploadAck = (
        await authedInject(app, auth, {
          method: 'POST',
          url: `/api/v1/backups/${backupId}/upload`,
        })
      ).json() as BackupJobAck;
      const job = await waitForJobToFinish(app, auth, uploadAck.jobId);
      expect(job.status).toBe('failed');
      expect(job.errorMessage).toMatch(/^Upload failed: /);
    } finally {
      fake.errorResponse = null;
    }

    const detail = (
      await authedInject(app, auth, { method: 'GET', url: `/api/v1/backups/${backupId}` })
    ).json() as BackupDetailResponse;
    expect(detail.backup.uploadStatus).toBe('failed');
    expect(detail.backup.localPresent).toBe(true);
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

describe('backups automation routes — verify and upload a new backup', () => {
  async function enableAutoUpload(app: BackupsHarness['app'], auth: Auth): Promise<void> {
    const response = await authedInject(app, auth, {
      method: 'PUT',
      url: '/api/v1/backups/schedule',
      payload: {
        frequency: 'off',
        mode: 'warm',
        retentionKeep: 3,
        retentionMaxAgeDays: null,
        uploadToRemote: true,
      },
    });
    expect(response.statusCode).toBe(200);
  }

  async function backupSummary(app: BackupsHarness['app'], auth: Auth, id: string) {
    const list = (
      await authedInject(app, auth, { method: 'GET', url: '/api/v1/backups' })
    ).json() as BackupListResponse;
    return list.backups.find((backup) => backup.id === id);
  }

  it('verifies a new backup and uploads it within its own create job', async () => {
    const { app } = await setUpBackupsApp(NO_TIMERS);
    const auth = await loginAs(app);
    await configureS3(app, auth);
    await enableAutoUpload(app, auth);

    const id = await createBackup(app, auth);

    expect(await backupSummary(app, auth, id)).toMatchObject({
      verificationStatus: 'verified',
      uploadStatus: 'uploaded',
      localPresent: false,
    });
    expect(fake.objects.has(`backups/${id}.tar`)).toBe(true);
  });

  it('leaves a new backup verified on the VPS when auto-upload is off', async () => {
    const { app } = await setUpBackupsApp(NO_TIMERS);
    const auth = await loginAs(app);
    await configureS3(app, auth);

    const id = await createBackup(app, auth);

    expect(await backupSummary(app, auth, id)).toMatchObject({
      verificationStatus: 'verified',
      uploadStatus: 'pending',
      localPresent: true,
    });
    expect(fake.objects.size).toBe(0);
  });
});
