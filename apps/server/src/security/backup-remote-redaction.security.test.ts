/**
 * SECURITY.md Part 5 check 8, for the M13 remote-backup feature: neither the
 * S3 secret access key nor the FTP password ever appears in logs, job logs,
 * HTTP responses, or the pre-change config snapshot, across a real config-apply
 * + upload driven through the actual code paths.
 *
 * `backup-destination-config.service.test.ts` already proves each secret is
 * masked in a `getStatus` response, revealed only through the audited
 * endpoint, and — per the redaction added alongside this file — absent from
 * the pre-change snapshot's `config_json`. What that unit-level test cannot
 * prove is that the *real app*, driven by *real requests*, never leaks the
 * secret anywhere else once it is actually in use — a handler or the uploader
 * logging a config object, the SigV4 signer logging a request, a basic-ftp
 * connection error including the password, or a signed URL reaching a log
 * line would all sail past a unit-level masking test while still leaking in
 * production.
 *
 * This file closes that gap end to end for both destination types: boots the
 * real app with a real (debug-level) logger writing to an in-memory sink,
 * configures a destination with a real secret pointing at an in-process fake
 * server, then creates and uploads a backup — the full sign-every-request (S3)
 * or login-every-connection (FTP) path — and asserts the literal secret value
 * appears in none of: the raw captured log text, the `job_logs` table, any of
 * the HTTP response bodies seen along the way (including a forced-failure
 * `/destination/test` error response and a forced-failure upload's
 * `uploadError` field), or the `backup_destination_snapshots.config_json`
 * rows written by the pre-change snapshot. A positive control per
 * destination type proves the capture would actually catch a leak.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import type { BackupDetailResponse, BackupJobAck, BackupListResponse } from '@dwg/shared';
import { buildApp } from '../app.js';
import { createDatabase, type Database } from '../platform/db.js';
import { migrations, runMigrations } from '../platform/migrations/index.js';
import { loadConfig } from '../platform/config.js';
import { REDACTION_PATHS } from '../platform/logger.js';
import { AdminsRepository } from '../modules/auth/admins.repository.js';
import { hashPassword } from '../modules/auth/password.js';
import {
  authedInject,
  loginAs,
  PRIMARY_EMAIL,
  PRIMARY_PASSWORD,
  waitForJobToFinish,
} from '../modules/backups/backups-test-harness.js';
import { startFakeS3, type FakeS3 } from '../modules/backups/destinations/fake-s3-server.js';
import { startFakeFtp, type FakeFtp } from '../modules/backups/destinations/fake-ftp-server.js';

// Distinctive, non-incidental sentinels so a false negative is impossible.
const SECRET = 'S3xSECRETxACCESSxKEYx7f3a9b2c1d4e';
const FTP_PASSWORD = 'FTPxSECRETxPASSWORDx9e2b7c4a1f60';

class CapturingSink {
  private chunks: string[] = [];
  write(chunk: string): void {
    this.chunks.push(chunk);
  }
  text(): string {
    return this.chunks.join('');
  }
}

async function bootApp(
  backupDir: string,
  sink: CapturingSink,
): Promise<{ app: Awaited<ReturnType<typeof buildApp>>; db: Database }> {
  const db = createDatabase(':memory:');
  runMigrations(db, migrations);
  const admins = new AdminsRepository(db);
  admins.create({
    email: PRIMARY_EMAIL,
    passwordHash: await hashPassword(PRIMARY_PASSWORD),
    role: 'administrator',
    forcePasswordChange: false,
  });

  const logger = pino(
    {
      name: '@dwg/server-remote-redaction-test',
      level: 'debug',
      redact: { paths: [...REDACTION_PATHS], censor: '[REDACTED]' },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    sink,
  );

  const config = loadConfig({ BACKUP_DIR: backupDir });
  const app = await buildApp({
    config,
    logger,
    db,
    backupSchedulerIntervalMs: 3_600_000,
    backupReconcileIntervalMs: 3_600_000,
  });
  return { app, db };
}

function snapshotConfigText(db: Database): string {
  return db
    .all<{ config_json: string }>(
      'SELECT config_json FROM backup_destination_snapshots ORDER BY created_at',
    )
    .map((row) => row.config_json)
    .join('\n');
}

describe('the S3 secret never leaks across a real config-apply + upload', () => {
  let fake: FakeS3;
  let backupDir: string;

  beforeEach(async () => {
    fake = await startFakeS3();
    backupDir = mkdtempSync(join(tmpdir(), 'dwg-remote-redaction-s3-'));
  });
  afterEach(async () => {
    await fake.close();
    rmSync(backupDir, { recursive: true, force: true });
  });

  it('is absent from logs, job logs, every response body, and the config snapshot', async () => {
    const sink = new CapturingSink();
    const { app, db } = await bootApp(backupDir, sink);
    const responseBodies: string[] = [];

    try {
      const auth = await loginAs(app);

      // 1. Apply the S3 destination config — the secret passes through the
      // request body here.
      responseBodies.push(
        (
          await authedInject(app, auth, {
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
          })
        ).body,
      );

      // 2. Create a backup.
      const createAck = (
        await authedInject(app, auth, {
          method: 'POST',
          url: '/api/v1/backups',
          payload: { mode: 'warm' },
        })
      ).json() as BackupJobAck;
      expect((await waitForJobToFinish(app, auth, createAck.jobId)).status).toBe('succeeded');

      const list = (
        await authedInject(app, auth, { method: 'GET', url: '/api/v1/backups' })
      ).json() as BackupListResponse;
      const backupId = list.backups[0]!.id;

      // 3. Upload it — the SigV4 signer uses the secret on every request.
      const uploadAck = (
        await authedInject(app, auth, {
          method: 'POST',
          url: `/api/v1/backups/${backupId}/upload`,
        })
      ).json() as BackupJobAck;
      expect((await waitForJobToFinish(app, auth, uploadAck.jobId)).status).toBe('succeeded');

      // 4. Re-apply with a trivial, non-secret change and the secret omitted
      // (kept from storage) — this takes a second pre-change snapshot whose
      // "prior" config held the real secret, exercising the redaction path.
      responseBodies.push(
        (
          await authedInject(app, auth, {
            method: 'PUT',
            url: '/api/v1/backups/destination',
            payload: {
              type: 's3',
              endpoint: `http://127.0.0.1:${fake.port}`,
              region: 'us-east-1',
              bucket: 'backups-bucket',
              prefix: 'backups-v2',
              accessKeyId: 'AKIAEXAMPLE',
            },
          })
        ).body,
      );

      // 5. Read paths that echo the destination — masked status + backup detail.
      responseBodies.push(
        (await authedInject(app, auth, { method: 'GET', url: '/api/v1/backups/destination' })).body,
      );
      responseBodies.push(
        (await authedInject(app, auth, { method: 'GET', url: `/api/v1/backups/${backupId}` })).body,
      );

      // --- Assertions ------------------------------------------------------
      const logText = sink.text();
      expect(logText.length).toBeGreaterThan(0); // something was actually logged

      const jobLogText = db
        .all<{ message: string }>('SELECT message FROM job_logs')
        .map((row) => row.message)
        .join('\n');

      expect(logText).not.toContain(SECRET);
      expect(jobLogText).not.toContain(SECRET);
      for (const body of responseBodies) {
        expect(body).not.toContain(SECRET);
      }

      // The pre-change snapshot must not carry the plaintext secret forward,
      // but non-secret identifiers (e.g. the access key id) are fine to keep.
      const snapshots = snapshotConfigText(db);
      expect(snapshots).not.toContain(SECRET);
      expect(snapshots).toContain('AKIAEXAMPLE');
    } finally {
      await app.close();
    }
  });

  it('positive control: the capture + search would catch a real leak (S3 secret)', () => {
    // Prove the sink captures pino output and a substring search finds a leaked
    // secret — so the absence assertions above are meaningful, not vacuous.
    const controlSink = new CapturingSink();
    const leakyLogger = pino({ level: 'debug' }, controlSink);
    leakyLogger.info({ deliberateLeak: SECRET }, 'control: this logger does not redact');
    expect(controlSink.text()).toContain(SECRET);
  });
});

describe('the FTP password never leaks across a real config-apply + upload', () => {
  let fake: FakeFtp;
  let backupDir: string;

  beforeEach(async () => {
    fake = await startFakeFtp();
    backupDir = mkdtempSync(join(tmpdir(), 'dwg-remote-redaction-ftp-'));
  });
  afterEach(async () => {
    await fake.close();
    rmSync(backupDir, { recursive: true, force: true });
  });

  it('is absent from logs, job logs, every response body, the config snapshot, and a forced-failure error message', async () => {
    const sink = new CapturingSink();
    const { app, db } = await bootApp(backupDir, sink);
    const responseBodies: string[] = [];

    try {
      const auth = await loginAs(app);

      // 1. Apply the FTP destination config — the password passes through the
      // request body here.
      responseBodies.push(
        (
          await authedInject(app, auth, {
            method: 'PUT',
            url: '/api/v1/backups/destination',
            payload: {
              type: 'ftp',
              host: '127.0.0.1',
              port: fake.port,
              path: 'backups',
              user: 'backup-user',
              secure: false,
              password: FTP_PASSWORD,
            },
          })
        ).body,
      );

      // 2. Create a backup.
      const createAck = (
        await authedInject(app, auth, {
          method: 'POST',
          url: '/api/v1/backups',
          payload: { mode: 'warm' },
        })
      ).json() as BackupJobAck;
      expect((await waitForJobToFinish(app, auth, createAck.jobId)).status).toBe('succeeded');

      const list = (
        await authedInject(app, auth, { method: 'GET', url: '/api/v1/backups' })
      ).json() as BackupListResponse;
      const backupId = list.backups[0]!.id;

      // 3. Upload it — basic-ftp logs in with the password on every connection.
      const uploadAck = (
        await authedInject(app, auth, {
          method: 'POST',
          url: `/api/v1/backups/${backupId}/upload`,
        })
      ).json() as BackupJobAck;
      expect((await waitForJobToFinish(app, auth, uploadAck.jobId)).status).toBe('succeeded');

      // 4. Re-apply with a trivial, non-secret change and the password omitted
      // (kept from storage) — this takes a second pre-change snapshot whose
      // "prior" config held the real password, exercising the redaction path.
      responseBodies.push(
        (
          await authedInject(app, auth, {
            method: 'PUT',
            url: '/api/v1/backups/destination',
            payload: {
              type: 'ftp',
              host: '127.0.0.1',
              port: fake.port,
              path: 'backups',
              user: 'backup-user-v2',
              secure: false,
            },
          })
        ).body,
      );

      // 5. Read paths that echo the destination — masked status, backup detail,
      // and the remote browse list.
      responseBodies.push(
        (await authedInject(app, auth, { method: 'GET', url: '/api/v1/backups/destination' })).body,
      );
      responseBodies.push(
        (await authedInject(app, auth, { method: 'GET', url: `/api/v1/backups/${backupId}` })).body,
      );
      responseBodies.push(
        (await authedInject(app, auth, { method: 'GET', url: '/api/v1/backups/remote' })).body,
      );

      // 6. Forced failure: take the fake FTP server down and drive both a
      // synchronous route (an immediate error HTTP response from
      // `FtpDestination#withClient`'s connect-failure branch) and an upload
      // job through the real failure path. `uploadBackup` never throws for a
      // remote failure (by design — see backup-uploader.ts), so the job
      // itself still reports `succeeded`; the failure instead lands in the
      // backup's `uploadError` field, which is what we check here.
      //
      // Retrying backup #1 would not exercise this: a successfully-uploaded
      // backup has its local archive reclaimed (`reclaimLocalStaging`), so a
      // second upload attempt on it is a local no-op `skipped` outcome, never
      // a real network attempt. A second, not-yet-uploaded backup is needed.
      await fake.close();

      const testConnResponse = await authedInject(app, auth, {
        method: 'POST',
        url: '/api/v1/backups/destination/test',
      });
      expect(testConnResponse.statusCode).toBeGreaterThanOrEqual(400);
      responseBodies.push(testConnResponse.body);

      const secondCreateAck = (
        await authedInject(app, auth, {
          method: 'POST',
          url: '/api/v1/backups',
          payload: { mode: 'warm' },
        })
      ).json() as BackupJobAck;
      expect((await waitForJobToFinish(app, auth, secondCreateAck.jobId)).status).toBe('succeeded');
      const secondList = (
        await authedInject(app, auth, { method: 'GET', url: '/api/v1/backups' })
      ).json() as BackupListResponse;
      const secondBackupId = secondList.backups.find((backup) => backup.id !== backupId)!.id;

      const failedUploadAck = (
        await authedInject(app, auth, {
          method: 'POST',
          url: `/api/v1/backups/${secondBackupId}/upload`,
        })
      ).json() as BackupJobAck;
      await waitForJobToFinish(app, auth, failedUploadAck.jobId);

      const failedDetailResponse = await authedInject(app, auth, {
        method: 'GET',
        url: `/api/v1/backups/${secondBackupId}`,
      });
      responseBodies.push(failedDetailResponse.body);
      const failedDetail = failedDetailResponse.json() as BackupDetailResponse;
      // Prove this is a genuine forced failure, not a vacuous check.
      expect(failedDetail.backup.uploadStatus).toBe('failed');
      expect(failedDetail.backup.uploadError).not.toBeNull();
      expect(failedDetail.backup.uploadError as string).not.toContain(FTP_PASSWORD);

      // --- Assertions ------------------------------------------------------
      const logText = sink.text();
      expect(logText.length).toBeGreaterThan(0); // something was actually logged

      const jobLogText = db
        .all<{ message: string }>('SELECT message FROM job_logs')
        .map((row) => row.message)
        .join('\n');

      expect(logText).not.toContain(FTP_PASSWORD);
      expect(jobLogText).not.toContain(FTP_PASSWORD);
      for (const body of responseBodies) {
        expect(body).not.toContain(FTP_PASSWORD);
      }

      // The pre-change snapshot must not carry the plaintext password forward,
      // but non-secret identifiers (e.g. the original user) are fine to keep.
      const snapshots = snapshotConfigText(db);
      expect(snapshots).not.toContain(FTP_PASSWORD);
      expect(snapshots).toContain('backup-user');
    } finally {
      await app.close();
    }
  });

  it('positive control: the capture + search would catch a real leak (FTP password)', () => {
    // Prove the sink captures pino output and a substring search finds a leaked
    // password — so the absence assertions above are meaningful, not vacuous.
    const controlSink = new CapturingSink();
    const leakyLogger = pino({ level: 'debug' }, controlSink);
    leakyLogger.info({ deliberateLeak: FTP_PASSWORD }, 'control: this logger does not redact');
    expect(controlSink.text()).toContain(FTP_PASSWORD);
  });
});
