import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BACKUP_VOLUME_KEYS } from '@dwg/shared';
import { FakeBrokerClient } from '../../drivers/broker/fake-broker-client.js';
import { buildFixtureVolumeTar } from '../../drivers/broker/fixtures/index.js';
import type { JobContext } from '../../platform/jobs/job-runner.js';
import {
  createBackupArchive,
  extractBackupArchiveForRestore,
  restoreVolumesFromExtractedArchive,
  verifyBackupArchive,
} from './backup-archive.js';

function silentCtx(): JobContext {
  return { jobId: 'test', log: () => {}, setProgress: () => {} };
}

describe('backup-archive', () => {
  let backupDir: string;

  beforeEach(() => {
    backupDir = mkdtempSync(join(tmpdir(), 'dwg-backup-archive-test-'));
  });

  afterEach(() => {
    rmSync(backupDir, { recursive: true, force: true });
  });

  it('creates an archive whose manifest round-trips: every volume and every fixture entry accounted for', async () => {
    const created = await createBackupArchive(
      {
        broker: new FakeBrokerClient(),
        backupDir,
        backupId: 'bkp_test1',
        mode: 'warm',
        createdBy: { adminId: 'admin_1', label: 'admin@example.com' },
        dmsImageDigest: 'sha256:abc123',
      },
      silentCtx(),
    );

    expect(created.manifest.mode).toBe('warm');
    expect(created.manifest.dmsImageDigest).toBe('sha256:abc123');
    expect(created.manifest.createdBy).toEqual({ adminId: 'admin_1', label: 'admin@example.com' });
    expect(created.manifest.volumes.map((v) => v.key).sort()).toEqual(
      [...BACKUP_VOLUME_KEYS].sort(),
    );

    // Every volume's entryCount matches how many manifest.entries actually
    // carry that volumeKey — the aggregate and the per-entry rows must
    // never disagree.
    for (const volume of created.manifest.volumes) {
      const matching = created.manifest.entries.filter((entry) => entry.volumeKey === volume.key);
      expect(matching).toHaveLength(volume.entryCount);
      expect(matching.reduce((sum, entry) => sum + entry.sizeBytes, 0)).toBe(volume.sizeBytes);
    }

    expect(created.sizeBytes).toBeGreaterThan(0);
    expect(created.checksumSha256).toMatch(/^[0-9a-f]{64}$/);

    const result = await verifyBackupArchive(created.filePath, created.manifest);
    expect(result).toEqual({ ok: true, reason: null });
  });

  it('detects tampering: flipping one byte inside the archive makes verify fail', async () => {
    const created = await createBackupArchive(
      {
        broker: new FakeBrokerClient(),
        backupDir,
        backupId: 'bkp_test2',
        mode: 'warm',
        createdBy: { adminId: null, label: 'admin@example.com' },
        dmsImageDigest: null,
      },
      silentCtx(),
    );

    const bytes = readFileSync(created.filePath);
    const tampered = Buffer.from(bytes);
    const offset = Math.floor(tampered.length / 2);
    tampered[offset] = (tampered[offset]! + 1) % 256;
    writeFileSync(created.filePath, tampered);

    const result = await verifyBackupArchive(created.filePath, created.manifest);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(result.reason).toMatch(/checksum mismatch|unreadable|missing/i);
  });

  it('verify fails (not throws) on a truncated/corrupted archive', async () => {
    const created = await createBackupArchive(
      {
        broker: new FakeBrokerClient(),
        backupDir,
        backupId: 'bkp_test3',
        mode: 'cold',
        createdBy: { adminId: null, label: 'admin@example.com' },
        dmsImageDigest: 'sha256:def456',
      },
      silentCtx(),
    );

    writeFileSync(created.filePath, readFileSync(created.filePath).subarray(0, 200));

    const result = await verifyBackupArchive(created.filePath, created.manifest);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('verify fails when the archive is missing entirely', async () => {
    const created = await createBackupArchive(
      {
        broker: new FakeBrokerClient(),
        backupDir,
        backupId: 'bkp_test4',
        mode: 'warm',
        createdBy: { adminId: null, label: 'admin@example.com' },
        dmsImageDigest: null,
      },
      silentCtx(),
    );
    rmSync(created.filePath);

    const result = await verifyBackupArchive(created.filePath, created.manifest);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unreadable/i);
  });

  it('preserves vmail uid/gid end to end: create then extract, still 5000:5000', async () => {
    const created = await createBackupArchive(
      {
        broker: new FakeBrokerClient(),
        backupDir,
        backupId: 'bkp_test5',
        mode: 'warm',
        createdBy: { adminId: null, label: 'admin@example.com' },
        dmsImageDigest: null,
      },
      silentCtx(),
    );

    const destDir = join(backupDir, 'extracted');
    await extractBackupArchiveForRestore(created.filePath, destDir);

    const tar = await import('tar');
    const uids: number[] = [];
    await tar.list({
      file: join(destDir, 'mail.tar'),
      onentry: (entry) => {
        if (entry.uid !== undefined) uids.push(entry.uid);
      },
    });
    expect(uids.length).toBeGreaterThan(0);
    expect(uids.every((uid) => uid === 5000)).toBe(true);
  });

  it('restores byte-for-byte: what archivePut receives matches what archiveGet originally returned', async () => {
    const putBodies: Partial<Record<string, Buffer>> = {};
    const broker = Object.assign(new FakeBrokerClient(), {
      archivePut: async (volumeKey: string, stream: NodeJS.ReadableStream) => {
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(chunk as Buffer);
        putBodies[volumeKey] = Buffer.concat(chunks);
      },
    });

    const created = await createBackupArchive(
      {
        broker,
        backupDir,
        backupId: 'bkp_test6',
        mode: 'warm',
        createdBy: { adminId: null, label: 'admin@example.com' },
        dmsImageDigest: null,
      },
      silentCtx(),
    );

    const destDir = join(backupDir, 'restore-extracted');
    await extractBackupArchiveForRestore(created.filePath, destDir);
    await restoreVolumesFromExtractedArchive(broker, destDir, silentCtx());

    for (const volumeKey of BACKUP_VOLUME_KEYS) {
      expect(putBodies[volumeKey]?.equals(buildFixtureVolumeTar(volumeKey))).toBe(true);
    }
  });
});
