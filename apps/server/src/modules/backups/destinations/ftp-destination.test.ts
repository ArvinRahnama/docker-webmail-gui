import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupObjectKey } from './destination.js';
import { startFakeFtp, type FakeFtp } from './fake-ftp-server.js';
import { FtpDestination, type FtpDestinationConfig } from './ftp-destination.js';

let fake: FakeFtp;
let workDir: string;

beforeEach(async () => {
  fake = await startFakeFtp();
  workDir = await mkdtemp(join(tmpdir(), 'ftp-dest-'));
});

afterEach(async () => {
  await fake.close();
  await rm(workDir, { recursive: true, force: true });
});

function makeDestination(overrides: Partial<FtpDestinationConfig> = {}): FtpDestination {
  return new FtpDestination({
    host: '127.0.0.1',
    port: fake.port,
    user: 'user',
    password: 'password',
    secure: false,
    path: 'backups',
    ...overrides,
  });
}

async function writeFixture(name: string, bytes: Buffer): Promise<string> {
  const path = join(workDir, name);
  await writeFile(path, bytes);
  return path;
}

describe('FtpDestination', () => {
  it('testConnection succeeds against a reachable server', async () => {
    await expect(makeDestination().testConnection()).resolves.toBeUndefined();
  });

  it('testConnection rejects when the server is unreachable', async () => {
    const dest = makeDestination();
    await fake.close();
    await expect(dest.testConnection()).rejects.toThrow(/Could not connect/);
  });

  it('round-trips a backup via upload, list, download and delete', async () => {
    const dest = makeDestination();
    const key = backupObjectKey('/backups', 'bkp_small');
    const payload = Buffer.from('an ftp backup archive body');
    const src = await writeFixture('small.tar', payload);

    await dest.upload({ key, filePath: src, sizeBytes: payload.length });
    expect(fake.files.get(key)).toEqual(payload);

    const listed = await dest.list();
    expect(listed.map((b) => b.key)).toContain(key);
    expect(listed.find((b) => b.key === key)?.sizeBytes).toBe(payload.length);

    const out = join(workDir, 'download.tar');
    await dest.download(key, out);
    expect(await readFile(out)).toEqual(payload);

    await dest.delete(key);
    expect(fake.files.has(key)).toBe(false);
  });

  it('resumes an interrupted upload by appending only the missing bytes (APPE)', async () => {
    const dest = makeDestination();
    const key = backupObjectKey('/backups', 'bkp_resume');
    const payload = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
    const src = await writeFixture('resume.tar', payload);

    // Simulate a prior interrupted upload: the first 10 bytes already landed.
    fake.files.set(key, payload.subarray(0, 10));

    await dest.upload({ key, filePath: src, sizeBytes: payload.length });

    // The remote now holds the whole payload, assembled from the partial + APPE.
    expect(fake.files.get(key)).toEqual(payload);
  });

  it('list ignores non-backup objects', async () => {
    const dest = makeDestination();
    const backupKey = backupObjectKey('/backups', 'bkp_real');
    fake.files.set(backupKey, Buffer.from('archive'));
    fake.files.set('/backups/readme.txt', Buffer.from('not a backup'));

    const listed = await dest.list();
    expect(listed.map((b) => b.key)).toEqual([backupKey]);
  });

  it('download of a missing key throws NOT_FOUND', async () => {
    const dest = makeDestination();
    await expect(dest.download('/backups/bkp_missing.tar', join(workDir, 'x.tar'))).rejects.toThrow(
      /No object/,
    );
  });

  it('delete is idempotent for a missing key', async () => {
    const dest = makeDestination();
    await expect(dest.delete('/backups/bkp_gone.tar')).resolves.toBeUndefined();
  });

  it('cleanupInterruptedUploads is a documented no-op', async () => {
    await expect(makeDestination().cleanupInterruptedUploads()).resolves.toBeUndefined();
  });
});
