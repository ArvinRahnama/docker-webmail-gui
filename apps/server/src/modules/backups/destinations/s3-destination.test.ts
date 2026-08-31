import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupObjectKey } from './destination.js';
import { startFakeS3, type FakeS3 } from './fake-s3-server.js';
import { S3Destination, type S3DestinationConfig } from './s3-destination.js';

let fake: FakeS3;
let workDir: string;

beforeEach(async () => {
  fake = await startFakeS3();
  workDir = await mkdtemp(join(tmpdir(), 's3-dest-'));
});

afterEach(async () => {
  await fake.close();
  await rm(workDir, { recursive: true, force: true });
});

function makeDestination(overrides: Partial<S3DestinationConfig> = {}): S3Destination {
  return new S3Destination({
    endpoint: `http://127.0.0.1:${fake.port}`,
    region: 'us-east-1',
    bucket: 'backups-bucket',
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'secretkey-value',
    prefix: 'backups',
    ...overrides,
  });
}

async function writeFixture(name: string, bytes: Buffer): Promise<string> {
  const path = join(workDir, name);
  await writeFile(path, bytes);
  return path;
}

describe('S3Destination', () => {
  it('testConnection succeeds against a reachable bucket and every request is SigV4-signed', async () => {
    const dest = makeDestination();
    await expect(dest.testConnection()).resolves.toBeUndefined();
    expect(fake.sawAuthOnEveryRequest()).toBe(true);
  });

  it('testConnection rejects when the endpoint is unreachable', async () => {
    const dest = makeDestination();
    await fake.close(); // now nothing is listening
    await expect(dest.testConnection()).rejects.toThrow();
  });

  it('round-trips a small backup via single-part upload, list, download and delete', async () => {
    const dest = makeDestination();
    const key = backupObjectKey('backups', 'bkp_small');
    const payload = Buffer.from('a small backup archive');
    const src = await writeFixture('small.tar', payload);

    await dest.upload({ key, filePath: src, sizeBytes: payload.length });
    expect(fake.objects.has(key)).toBe(true);

    const listed = await dest.list();
    expect(listed.map((b) => b.key)).toContain(key);

    const out = join(workDir, 'small-download.tar');
    await dest.download(key, out);
    expect(await readFile(out)).toEqual(payload);

    await dest.delete(key);
    expect(fake.objects.has(key)).toBe(false);
  });

  it('uploads a larger backup as a multipart upload and reassembles it byte-for-byte', async () => {
    // Tiny part size forces several parts for a small file.
    const dest = makeDestination({ partSizeBytes: 5, multipartThresholdBytes: 5 });
    const key = backupObjectKey('backups', 'bkp_multi');
    const payload = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz'); // 36 bytes -> 8 parts
    const src = await writeFixture('multi.tar', payload);

    await dest.upload({ key, filePath: src, sizeBytes: payload.length });

    // Multipart state was fully completed (no dangling upload left behind).
    expect(fake.multipart.size).toBe(0);
    expect(fake.objects.get(key)).toEqual(payload);
    expect(fake.sawAuthOnEveryRequest()).toBe(true);

    const out = join(workDir, 'multi-download.tar');
    await dest.download(key, out);
    expect(await readFile(out)).toEqual(payload);
  });

  it('retries a transiently failing part and still completes the upload', async () => {
    const dest = makeDestination({ partSizeBytes: 5, multipartThresholdBytes: 5 });
    const key = backupObjectKey('backups', 'bkp_retry');
    const payload = Buffer.from('the quick brown fox jumps'); // 25 bytes -> 5 parts
    const src = await writeFixture('retry.tar', payload);

    fake.failPartOnce = 2; // part 2's first PUT returns 500, then succeeds on retry

    await dest.upload({ key, filePath: src, sizeBytes: payload.length });

    expect(fake.multipart.size).toBe(0);
    expect(fake.objects.get(key)).toEqual(payload);
  });

  it('list ignores non-backup objects under the prefix', async () => {
    const dest = makeDestination();
    const backupKey = backupObjectKey('backups', 'bkp_real');
    fake.objects.set(backupKey, Buffer.from('archive'));
    fake.objects.set('backups/readme.txt', Buffer.from('not a backup'));

    const listed = await dest.list();
    expect(listed.map((b) => b.key)).toEqual([backupKey]);
  });

  it('cleanupInterruptedUploads aborts stale multipart uploads left behind', async () => {
    const dest = makeDestination();
    fake.multipart.set('stale-1', { key: 'backups/bkp_stale.tar', parts: new Map() });
    fake.multipart.set('stale-2', { key: 'backups/bkp_other.tar', parts: new Map() });

    await dest.cleanupInterruptedUploads();

    expect(fake.multipart.size).toBe(0);
  });

  it('download of a missing key throws NOT_FOUND', async () => {
    const dest = makeDestination();
    await expect(dest.download('backups/bkp_missing.tar', join(workDir, 'x.tar'))).rejects.toThrow(
      /No object/,
    );
  });
});
