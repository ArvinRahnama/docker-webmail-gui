import { describe, expect, it } from 'vitest';
import type { BackupManifest } from '@dwg/shared';
import { createDatabase, type Database } from '../../platform/db.js';
import { migrations, runMigrations } from '../../platform/migrations/index.js';
import { BackupsRepository } from './backups.repository.js';

function manifest(createdAt: string): BackupManifest {
  return {
    schemaVersion: 1,
    panelVersion: '0.3.0',
    dmsImageDigest: 'sha256:abc',
    createdAt,
    createdBy: { adminId: null, label: 'test' },
    mode: 'warm',
    volumes: [],
    entries: [],
    notes: 'test',
  };
}

function setUp(): { db: Database; repo: BackupsRepository } {
  const db = createDatabase(':memory:');
  runMigrations(db, migrations);
  return { db, repo: new BackupsRepository(db) };
}

function insert(repo: BackupsRepository, id: string, createdAt: string): void {
  repo.insert({
    id,
    createdByAdminId: null,
    filePath: `/tmp/${id}.tar`,
    sizeBytes: 10,
    checksum: 'a'.repeat(64),
    manifest: manifest(createdAt),
  });
}

describe('BackupsRepository upload state (M13)', () => {
  it('a freshly inserted backup is pending, local-present, with no upload metadata', () => {
    const { repo } = setUp();
    insert(repo, 'bkp_1', '2026-08-01T00:00:00.000Z');
    const summary = repo.getSummaryById('bkp_1');
    expect(summary).toMatchObject({
      uploadStatus: 'pending',
      uploadDestination: null,
      uploadedAt: null,
      uploadError: null,
      localPresent: true,
    });
  });

  it('walks pending -> uploading -> uploaded, recording destination, key and timestamp', () => {
    const { repo } = setUp();
    insert(repo, 'bkp_1', '2026-08-01T00:00:00.000Z');

    repo.markUploading('bkp_1');
    expect(repo.getSummaryById('bkp_1')?.uploadStatus).toBe('uploading');

    repo.markUploaded('bkp_1', {
      destination: 's3://bucket/backups',
      remoteKey: 'backups/bkp_1.tar',
      uploadedAt: '2026-08-01T01:00:00.000Z',
    });
    const summary = repo.getSummaryById('bkp_1');
    expect(summary).toMatchObject({
      uploadStatus: 'uploaded',
      uploadDestination: 's3://bucket/backups',
      uploadedAt: '2026-08-01T01:00:00.000Z',
      uploadError: null,
    });
    expect(repo.getRowById('bkp_1')?.remote_key).toBe('backups/bkp_1.tar');
  });

  it('markUploadFailed keeps the local copy and records a bounded error message', () => {
    const { repo } = setUp();
    insert(repo, 'bkp_1', '2026-08-01T00:00:00.000Z');
    repo.markUploadFailed('bkp_1', 'x'.repeat(2000));
    const summary = repo.getSummaryById('bkp_1');
    expect(summary?.uploadStatus).toBe('failed');
    expect(summary?.localPresent).toBe(true);
    expect(summary?.uploadError?.length).toBe(500); // capped
  });

  it('markLocalReclaimed flips local_present but keeps the (remote-only) row', () => {
    const { repo } = setUp();
    insert(repo, 'bkp_1', '2026-08-01T00:00:00.000Z');
    repo.markUploaded('bkp_1', {
      destination: 's3://bucket/backups',
      remoteKey: 'backups/bkp_1.tar',
      uploadedAt: '2026-08-01T01:00:00.000Z',
    });
    repo.markLocalReclaimed('bkp_1');
    const summary = repo.getSummaryById('bkp_1');
    expect(summary).not.toBeNull();
    expect(summary?.localPresent).toBe(false);
    expect(summary?.uploadStatus).toBe('uploaded');
  });

  it('listUploadCandidates returns pending/failed local backups oldest-first, excluding uploaded and reclaimed', () => {
    const { repo } = setUp();
    insert(repo, 'bkp_old', '2026-08-01T00:00:00.000Z'); // pending
    insert(repo, 'bkp_mid', '2026-08-02T00:00:00.000Z'); // will fail
    insert(repo, 'bkp_new', '2026-08-03T00:00:00.000Z'); // will be uploaded + reclaimed
    repo.markUploadFailed('bkp_mid', 'transient');
    repo.markUploaded('bkp_new', {
      destination: 's3://bucket/backups',
      remoteKey: 'backups/bkp_new.tar',
      uploadedAt: '2026-08-03T01:00:00.000Z',
    });
    repo.markLocalReclaimed('bkp_new');

    expect(repo.listUploadCandidates().map((r) => r.id)).toEqual(['bkp_old', 'bkp_mid']);
    expect(repo.listUploaded().map((r) => r.id)).toEqual(['bkp_new']);
  });
});
