/**
 * SECURITY.md Part 5 check 8, for the M13 remote-backup feature: the S3 secret
 * access key never appears in logs, job logs, or HTTP responses across a real
 * config-apply + upload.
 *
 * `backup-destination-config.service.test.ts` already proves the secret is
 * masked in a `getStatus` response and revealed only through the audited
 * endpoint. What that cannot prove is that the *real app*, driven by *real
 * requests*, never leaks the secret anywhere else once it is actually in use —
 * a handler or the uploader logging a config object, the SigV4 signer logging
 * a request, or a signed URL reaching a log line would all sail past a
 * unit-level masking test while still leaking in production.
 *
 * This file closes that gap end to end: boots the real app with a real
 * (debug-level) logger writing to an in-memory sink, configures an S3
 * destination with a real secret pointing at the in-process fake S3, then
 * creates and uploads a backup — the full sign-every-request upload path — and
 * asserts the literal secret value appears in none of: the raw captured log
 * text, the `job_logs` table, or any of the HTTP response bodies seen along
 * the way. A positive control proves the capture would actually catch a leak.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import type { BackupJobAck, BackupListResponse } from '@dwg/shared';
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

// A distinctive, non-incidental value so a false negative is impossible.
const SECRET = 'S3xSECRETxACCESSxKEYx7f3a9b2c1d4e';

class CapturingSink {
  private chunks: string[] = [];
  write(chunk: string): void {
    this.chunks.push(chunk);
  }
  text(): string {
    return this.chunks.join('');
  }
}

let fake: FakeS3;
let backupDir: string;

beforeEach(async () => {
  fake = await startFakeS3();
  backupDir = mkdtempSync(join(tmpdir(), 'dwg-remote-redaction-'));
});
afterEach(async () => {
  await fake.close();
  rmSync(backupDir, { recursive: true, force: true });
});

async function bootApp(
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

describe('the S3 secret never leaks across a real config-apply + upload', () => {
  it('is absent from logs, job logs, and every response body', async () => {
    const sink = new CapturingSink();
    const { app, db } = await bootApp(sink);
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

      // 4. Read paths that echo the destination — masked status + backup detail.
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
    } finally {
      await app.close();
    }
  });

  it('positive control: the capture + search would catch a real leak', () => {
    // Prove the sink captures pino output and a substring search finds a leaked
    // secret — so the absence assertions above are meaningful, not vacuous.
    const controlSink = new CapturingSink();
    const leakyLogger = pino({ level: 'debug' }, controlSink);
    leakyLogger.info({ deliberateLeak: SECRET }, 'control: this logger does not redact');
    expect(controlSink.text()).toContain(SECRET);
  });
});
