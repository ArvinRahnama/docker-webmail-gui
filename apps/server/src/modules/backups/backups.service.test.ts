import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeBrokerClient } from '../../drivers/broker/fake-broker-client.js';
import { createDatabase, type Database } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import { createJobRunner } from '../../platform/jobs/job-runner.js';
import { JobsRepository } from '../../platform/jobs/jobs.repository.js';
import { createLogger } from '../../platform/logger.js';
import { migrations, runMigrations } from '../../platform/migrations/index.js';
import type { BackupUploader } from './backup-uploader.js';
import { BackupsRepository } from './backups.repository.js';
import { BackupsService } from './backups.service.js';

const verification = vi.hoisted(() => ({ forceFailure: null as string | null }));

// Archives built from the fake broker always verify, so the one way to reach
// the create job's "verification failed" branch is to make verify say so.
vi.mock('./backup-archive.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./backup-archive.js')>();
  return {
    ...actual,
    verifyBackupArchive: async (...args: Parameters<typeof actual.verifyBackupArchive>) =>
      verification.forceFailure === null
        ? actual.verifyBackupArchive(...args)
        : { ok: false, reason: verification.forceFailure },
  };
});

const ACTOR = { adminId: null, label: 'test' };

let db: Database;
let jobs: JobsRepository;
let repo: BackupsRepository;
let backupDir: string;

beforeEach(async () => {
  verification.forceFailure = null;
  db = createDatabase(':memory:');
  runMigrations(db, migrations);
  jobs = new JobsRepository(db);
  repo = new BackupsRepository(db);
  backupDir = await mkdtemp(join(tmpdir(), 'dwg-backups-service-'));
});

afterEach(async () => {
  db.close();
  await rm(backupDir, { recursive: true, force: true });
});

function uploaderStub(overrides: Partial<BackupUploader> = {}) {
  return {
    uploadBackup: vi.fn(async () => ({ status: 'uploaded' as const })),
    ...overrides,
  } as unknown as BackupUploader & {
    uploadBackup: ReturnType<typeof vi.fn>;
  };
}

function service(uploader: BackupUploader, autoUpload = true): BackupsService {
  const runner = createJobRunner(jobs, createLogger({ level: 'silent' }));
  return new BackupsService(repo, runner, new FakeBrokerClient(), backupDir, {
    uploader,
    autoUploadEnabled: () => autoUpload,
  });
}

async function finished(jobId: string) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const job = jobs.getById(jobId)!;
    if (job.status !== 'queued' && job.status !== 'running') return job;
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not finish`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('BackupsService.create', () => {
  it('verifies the new backup, then uploads it, all in the create job', async () => {
    const uploader = uploaderStub();
    const job = service(uploader).create('warm', ACTOR);

    const done = await finished(job.id);

    expect(done.status).toBe('succeeded');
    const [backup] = repo.list();
    expect(backup?.verificationStatus).toBe('verified');
    expect(uploader.uploadBackup).toHaveBeenCalledWith(backup!.id, ACTOR);
    const messages = jobs.listLogs(job.id).map((entry) => entry.message);
    const verifiedAt = messages.findIndex((m) => m.startsWith('Verification succeeded'));
    const uploadAt = messages.findIndex((m) => m.startsWith('Uploading'));
    expect(verifiedAt).toBeGreaterThan(-1);
    expect(uploadAt).toBeGreaterThan(verifiedAt);
  });

  it('fails the job and uploads nothing when the new archive does not verify', async () => {
    verification.forceFailure = 'Checksum mismatch for mail.tar';
    const uploader = uploaderStub();
    const job = service(uploader).create('warm', ACTOR);

    const done = await finished(job.id);

    expect(done.status).toBe('failed');
    expect(done.errorMessage).toMatch(/failed verification, so it was not uploaded/);
    expect(repo.list()[0]?.verificationStatus).toBe('failed');
    expect(uploader.uploadBackup).not.toHaveBeenCalled();
  });

  it('does not upload when auto-upload is off', async () => {
    const uploader = uploaderStub();
    const done = await finished(service(uploader, false).create('warm', ACTOR).id);
    expect(done.status).toBe('succeeded');
    expect(uploader.uploadBackup).not.toHaveBeenCalled();
  });

  it('keeps the create job a success when the upload step throws — the backup exists and verified', async () => {
    const uploader = uploaderStub({
      uploadBackup: vi.fn(async () => {
        throw new AppError('UPSTREAM_UNAVAILABLE', 'S3 list failed (HTTP 500).');
      }),
    });
    const job = service(uploader).create('warm', ACTOR);

    const done = await finished(job.id);

    expect(done.status).toBe('succeeded');
    expect(repo.list()[0]?.verificationStatus).toBe('verified');
    expect(jobs.listLogs(job.id).some((entry) => entry.level === 'warn')).toBe(true);
  });
});
