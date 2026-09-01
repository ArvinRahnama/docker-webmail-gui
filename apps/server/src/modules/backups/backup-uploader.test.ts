import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BackupManifest } from '@dwg/shared';
import { FakeBrokerClient } from '../../drivers/broker/fake-broker-client.js';
import { createDatabase, type Database } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import type { JobContext } from '../../platform/jobs/job-runner.js';
import { createLogger } from '../../platform/logger.js';
import { migrations, runMigrations } from '../../platform/migrations/index.js';
import { createBackupArchive } from './backup-archive.js';
import { BackupUploader } from './backup-uploader.js';
import { BackupsRepository } from './backups.repository.js';
import type { BackupDestination, RemoteBackup, UploadParams } from './destinations/destination.js';
import { startFakeS3, type FakeS3 } from './destinations/fake-s3-server.js';
import { S3Destination } from './destinations/s3-destination.js';

function silentCtx(): JobContext {
  return { jobId: 'test', log: () => {}, setProgress: () => {} };
}

function minimalManifest(createdAt: string): BackupManifest {
  return {
    schemaVersion: 1,
    panelVersion: '0.3.0',
    dmsImageDigest: null,
    createdAt,
    createdBy: { adminId: null, label: 'test' },
    mode: 'warm',
    volumes: [],
    entries: [],
    notes: 'test',
  };
}

/** A programmable destination for the controlled tests (verify-failure, retention). */
class StubDestination implements BackupDestination {
  readonly type = 's3' as const;
  readonly describe = 's3://stub/prefix';
  readonly objects = new Map<string, Buffer>();
  readonly deleted: string[] = [];
  listOverride: RemoteBackup[] | null = null;
  uploadThrows = false;
  corruptOnUpload = false;

  keyForBackup(id: string): string {
    return `prefix/${id}.tar`;
  }
  testConnection(): Promise<void> {
    return Promise.resolve();
  }
  list(): Promise<readonly RemoteBackup[]> {
    if (this.listOverride !== null) return Promise.resolve(this.listOverride);
    return Promise.resolve(
      [...this.objects.entries()].map(([key, body]) => ({
        key,
        sizeBytes: body.length,
        lastModified: '2026-01-01T00:00:00.000Z',
      })),
    );
  }
  async upload(params: UploadParams): Promise<void> {
    if (this.uploadThrows) throw new Error('simulated upload failure');
    const bytes = await readFile(params.filePath);
    this.objects.set(params.key, this.corruptOnUpload ? Buffer.from('corrupt-bytes') : bytes);
  }
  async download(key: string, destPath: string): Promise<void> {
    const body = this.objects.get(key);
    if (body === undefined) throw new AppError('NOT_FOUND', `no ${key}`);
    await writeFile(destPath, body);
  }
  delete(key: string): Promise<void> {
    this.deleted.push(key);
    this.objects.delete(key);
    return Promise.resolve();
  }
  cleanupInterruptedUploads(): Promise<void> {
    return Promise.resolve();
  }
}

let db: Database;
let repo: BackupsRepository;
let backupDir: string;

beforeEach(async () => {
  db = createDatabase(':memory:');
  runMigrations(db, migrations);
  repo = new BackupsRepository(db);
  backupDir = await mkdtemp(join(tmpdir(), 'dwg-uploader-'));
});

afterEach(async () => {
  db.close();
  await rm(backupDir, { recursive: true, force: true });
});

async function createRealBackup(id: string): Promise<string> {
  const created = await createBackupArchive(
    {
      broker: new FakeBrokerClient(),
      backupDir,
      backupId: id,
      mode: 'warm',
      createdBy: { adminId: null, label: 'test' },
      dmsImageDigest: null,
    },
    silentCtx(),
  );
  repo.insert({
    id,
    createdByAdminId: null,
    filePath: created.filePath,
    sizeBytes: created.sizeBytes,
    checksum: created.checksumSha256,
    manifest: created.manifest,
  });
  return created.filePath;
}

function makeUploader(destination: BackupDestination | null, keep = 10): BackupUploader {
  return new BackupUploader({
    db,
    backupsRepository: repo,
    destinationProvider: () => destination,
    retentionPolicy: () => ({ keep, maxAgeDays: null }),
    backupDir,
    logger: createLogger({ level: 'silent' }),
  });
}

function auditRows(action: string): { action: string; result: string }[] {
  return db.all<{ action: string; result: string }>(
    'SELECT action, result FROM audit_log WHERE action = ? ORDER BY occurred_at',
    [action],
  );
}

describe('BackupUploader.uploadBackup', () => {
  it('uploads to a real S3 fake, verifies the remote copy, then reclaims the local archive', async () => {
    const fake: FakeS3 = await startFakeS3();
    try {
      const destination = new S3Destination({
        endpoint: `http://127.0.0.1:${fake.port}`,
        region: 'us-east-1',
        bucket: 'backups-bucket',
        accessKeyId: 'AKIAEXAMPLE',
        secretAccessKey: 'secret',
        prefix: 'backups',
      });
      const filePath = await createRealBackup('bkp_1');
      const originalBytes = await readFile(filePath);

      const outcome = await makeUploader(destination).uploadBackup('bkp_1', {
        adminId: null,
        label: 'admin@example.com',
      });

      expect(outcome).toEqual({ status: 'uploaded' });
      const summary = repo.getSummaryById('bkp_1');
      expect(summary?.uploadStatus).toBe('uploaded');
      expect(summary?.uploadDestination).toBe('s3://backups-bucket/backups');
      expect(summary?.localPresent).toBe(false);
      // The remote holds the exact archive bytes...
      expect(fake.objects.get('backups/bkp_1.tar')).toEqual(originalBytes);
      // ...and ONLY after that verified upload is the local archive gone.
      expect(existsSync(filePath)).toBe(false);
      expect(auditRows('backup.upload')).toEqual([{ action: 'backup.upload', result: 'success' }]);
    } finally {
      await fake.close();
    }
  });

  it('uploads a larger archive via multipart and still reclaims local only after verifying', async () => {
    const fake: FakeS3 = await startFakeS3();
    try {
      const destination = new S3Destination({
        endpoint: `http://127.0.0.1:${fake.port}`,
        region: 'us-east-1',
        bucket: 'backups-bucket',
        accessKeyId: 'AKIAEXAMPLE',
        secretAccessKey: 'secret',
        prefix: 'backups',
        partSizeBytes: 256,
        multipartThresholdBytes: 256,
      });
      const filePath = await createRealBackup('bkp_multi');
      const originalBytes = await readFile(filePath);

      const outcome = await makeUploader(destination).uploadBackup('bkp_multi');

      expect(outcome).toEqual({ status: 'uploaded' });
      expect(fake.objects.get('backups/bkp_multi.tar')).toEqual(originalBytes);
      expect(existsSync(filePath)).toBe(false);
    } finally {
      await fake.close();
    }
  });

  it('with no destination configured, does nothing and keeps the local archive', async () => {
    const filePath = await createRealBackup('bkp_1');
    const outcome = await makeUploader(null).uploadBackup('bkp_1');
    expect(outcome).toEqual({ status: 'skipped', reason: 'no-destination' });
    expect(repo.getSummaryById('bkp_1')?.uploadStatus).toBe('pending');
    expect(existsSync(filePath)).toBe(true);
  });

  it('when the remote copy fails verification, marks failed, deletes the bad remote object, and KEEPS the local archive', async () => {
    const filePath = await createRealBackup('bkp_1');
    const stub = new StubDestination();
    stub.corruptOnUpload = true; // remote copy will not verify

    const outcome = await makeUploader(stub).uploadBackup('bkp_1');

    expect(outcome.status).toBe('failed');
    const summary = repo.getSummaryById('bkp_1');
    expect(summary?.uploadStatus).toBe('failed');
    expect(summary?.uploadError).toBeTruthy();
    // The invariant: an unverified upload must not cost us the local copy.
    expect(summary?.localPresent).toBe(true);
    expect(existsSync(filePath)).toBe(true);
    // And the corrupt remote object is removed so it can't masquerade as good.
    expect(stub.deleted).toContain('prefix/bkp_1.tar');
    expect(auditRows('backup.upload')).toEqual([{ action: 'backup.upload', result: 'failure' }]);
  });

  it('when the upload itself throws, marks failed and keeps the local archive', async () => {
    const filePath = await createRealBackup('bkp_1');
    const stub = new StubDestination();
    stub.uploadThrows = true;

    const outcome = await makeUploader(stub).uploadBackup('bkp_1');

    expect(outcome.status).toBe('failed');
    expect(repo.getSummaryById('bkp_1')?.uploadStatus).toBe('failed');
    expect(existsSync(filePath)).toBe(true);
  });
});

describe('BackupUploader.reconcile', () => {
  it('is a no-op when no destination is configured', async () => {
    await createRealBackup('bkp_1');
    const summary = await makeUploader(null).reconcile();
    expect(summary).toEqual({ skipped: true, uploaded: 0, failed: 0, pruned: 0, reclaimed: 0 });
    expect(repo.getSummaryById('bkp_1')?.uploadStatus).toBe('pending');
  });

  it('uploads every backlogged local backup, then reclaims each (multiple-pending edge case)', async () => {
    const stub = new StubDestination();
    await createRealBackup('bkp_1');
    await createRealBackup('bkp_2');
    await createRealBackup('bkp_3');

    const summary = await makeUploader(stub, 10).reconcile();

    expect(summary).toMatchObject({ skipped: false, uploaded: 3, failed: 0, reclaimed: 3 });
    expect(stub.objects.size).toBe(3);
    for (const id of ['bkp_1', 'bkp_2', 'bkp_3']) {
      expect(repo.getSummaryById(id)?.uploadStatus).toBe('uploaded');
      expect(repo.getSummaryById(id)?.localPresent).toBe(false);
    }
  });

  it('prunes the remote to the newest `keep` and reconciles the pruned rows out of the DB', async () => {
    const stub = new StubDestination();
    // Five already-uploaded, already-reclaimed backups on the remote.
    for (let i = 1; i <= 5; i += 1) {
      const id = `bkp_${i}`;
      repo.insert({
        id,
        createdByAdminId: null,
        filePath: join(backupDir, `${id}.tar`),
        sizeBytes: 10,
        checksum: 'a'.repeat(64),
        manifest: minimalManifest(`2026-08-0${i}T00:00:00.000Z`),
      });
      const key = stub.keyForBackup(id);
      stub.objects.set(key, Buffer.from('x'));
      repo.markUploaded(id, { destination: stub.describe, remoteKey: key, uploadedAt: 'x' });
      repo.markLocalReclaimed(id);
    }
    // Newest first: bkp_5 .. bkp_1.
    stub.listOverride = [5, 4, 3, 2, 1].map((i) => ({
      key: stub.keyForBackup(`bkp_${i}`),
      sizeBytes: 1,
      lastModified: `2026-08-0${i}T00:00:00.000Z`,
    }));

    const summary = await makeUploader(stub, 3).reconcile();

    expect(summary.pruned).toBe(2);
    // The two oldest were pruned from the remote and dropped from the DB.
    expect(stub.deleted.sort()).toEqual(
      [stub.keyForBackup('bkp_1'), stub.keyForBackup('bkp_2')].sort(),
    );
    expect(repo.getSummaryById('bkp_1')).toBeNull();
    expect(repo.getSummaryById('bkp_2')).toBeNull();
    expect(repo.getSummaryById('bkp_3')).not.toBeNull();
    expect(auditRows('backup.remote_prune')).toHaveLength(2);
  });
});

/** Produces a real archive's bytes without inserting a DB row (for foreign-import tests). */
async function realArchiveBytes(id: string): Promise<Buffer> {
  const created = await createBackupArchive(
    {
      broker: new FakeBrokerClient(),
      backupDir,
      backupId: id,
      mode: 'warm',
      createdBy: { adminId: null, label: 'test' },
      dmsImageDigest: null,
    },
    silentCtx(),
  );
  const bytes = await readFile(created.filePath);
  await rm(created.filePath, { force: true });
  return bytes;
}

describe('BackupUploader.importFromRemote', () => {
  it('throws when no destination is configured', async () => {
    await expect(makeUploader(null).importFromRemote('bkp_x')).rejects.toThrow(/No remote/);
  });

  it('imports a foreign backup: verifies, registers it as a local + uploaded backup', async () => {
    const stub = new StubDestination();
    const bytes = await realArchiveBytes('source');
    stub.objects.set(stub.keyForBackup('bkp_foreign'), bytes);

    const outcome = await makeUploader(stub).importFromRemote('bkp_foreign');

    expect(outcome).toEqual({ status: 'imported' });
    const summary = repo.getSummaryById('bkp_foreign');
    expect(summary).not.toBeNull();
    expect(summary?.localPresent).toBe(true);
    expect(summary?.uploadStatus).toBe('uploaded');
    expect(existsSync(join(backupDir, 'bkp_foreign.tar'))).toBe(true);
  });

  it('refuses a corrupt remote archive: fails verification, registers nothing, leaves no staged file', async () => {
    const stub = new StubDestination();
    stub.objects.set(stub.keyForBackup('bkp_bad'), Buffer.from('this is not a valid tar archive'));

    await expect(makeUploader(stub).importFromRemote('bkp_bad')).rejects.toThrow(
      /unreadable|failed verification/i,
    );
    expect(repo.getSummaryById('bkp_bad')).toBeNull();
    expect(existsSync(join(backupDir, 'bkp_bad.tar'))).toBe(false);
  });

  it('detects tampering against the panel-stored manifest and refuses', async () => {
    // A backup the panel created and reclaimed locally, whose remote copy has
    // since been tampered with — verification against the stored manifest fails.
    await createRealBackup('bkp_known');
    const good = await readFile(join(backupDir, 'bkp_known.tar'));
    const tampered = Buffer.from(good);
    tampered[Math.floor(tampered.length / 2)] =
      (tampered[Math.floor(tampered.length / 2)]! + 1) % 256;

    const stub = new StubDestination();
    stub.objects.set(stub.keyForBackup('bkp_known'), tampered);
    repo.markUploaded('bkp_known', {
      destination: stub.describe,
      remoteKey: stub.keyForBackup('bkp_known'),
      uploadedAt: 'x',
    });
    // Simulate local reclaimed so import will actually pull.
    await rm(join(backupDir, 'bkp_known.tar'), { force: true });
    repo.markLocalReclaimed('bkp_known');

    await expect(makeUploader(stub).importFromRemote('bkp_known')).rejects.toThrow(
      /failed verification/i,
    );
    expect(repo.getSummaryById('bkp_known')?.localPresent).toBe(false); // unchanged
  });

  it('re-imports a reclaimed panel backup, flipping it back to locally present', async () => {
    await createRealBackup('bkp_known');
    const good = await readFile(join(backupDir, 'bkp_known.tar'));
    const stub = new StubDestination();
    stub.objects.set(stub.keyForBackup('bkp_known'), good);
    repo.markUploaded('bkp_known', {
      destination: stub.describe,
      remoteKey: stub.keyForBackup('bkp_known'),
      uploadedAt: 'x',
    });
    await rm(join(backupDir, 'bkp_known.tar'), { force: true });
    repo.markLocalReclaimed('bkp_known');

    const outcome = await makeUploader(stub).importFromRemote('bkp_known');
    expect(outcome).toEqual({ status: 'imported' });
    expect(repo.getSummaryById('bkp_known')?.localPresent).toBe(true);
  });

  it('is a no-op when the backup is already local', async () => {
    await createRealBackup('bkp_local');
    const stub = new StubDestination();
    expect(await makeUploader(stub).importFromRemote('bkp_local')).toEqual({
      status: 'already-local',
    });
  });
});
