import { createServer } from 'node:http';
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
    await expect(dest.testConnection()).rejects.toThrow(
      /Could not connect to http:\/\/127\.0\.0\.1:\d+ \(ECONNREFUSED\)/,
    );
  });

  it('a connect failure names only the endpoint origin, never userinfo, path or query stored in it', async () => {
    const port = fake.port;
    await fake.close();
    const dest = makeDestination({
      endpoint: `http://user:TOPSECRET@127.0.0.1:${port}/TOPSECRET-path?token=TOPSECRET`,
    });
    const failure = dest.testConnection();
    await expect(failure).rejects.toThrow(
      new RegExp(`^Could not connect to http://127\\.0\\.0\\.1:${port} \\(`),
    );
    await expect(failure).rejects.not.toThrow(/TOPSECRET/);
  });

  it('testConnection names the bucket an endpoint actually serves when it differs', async () => {
    fake.servedBucket = 'c123456';
    const dest = makeDestination({ bucket: 'Company-Website' });
    await expect(dest.testConnection()).rejects.toThrow(
      'This endpoint serves bucket "c123456", not "Company-Website" — set Bucket to c123456.',
    );

    await expect(makeDestination({ bucket: 'c123456' }).testConnection()).resolves.toBeUndefined();
  });

  it('testConnection blames an endpoint path, not the bucket, when the path was taken as the bucket', async () => {
    fake.knownBuckets = ['backups-bucket'];
    const dest = makeDestination({ endpoint: `http://127.0.0.1:${fake.port}/minio` });
    const failure = dest.testConnection();
    await expect(failure).rejects.toThrow(
      /endpoint URL has a path \(\/minio\).*bucket "minio" instead of "backups-bucket"\. Remove the path/,
    );
    await expect(failure).rejects.not.toThrow(/set Bucket/);

    await expect(makeDestination().testConnection()).resolves.toBeUndefined();
  });

  it.each([
    [404, 'NoSuchBucket', /Bucket "backups-bucket" does not exist/],
    [403, 'InvalidAccessKeyId', /does not recognise this access key ID/],
    [403, 'SignatureDoesNotMatch', /rejected the request signature.*secret access key/],
    [403, 'AccessDenied', /Access to bucket "backups-bucket" was denied/],
    [400, 'AuthorizationHeaderMalformed', /rejected the region\. Check the Region field/],
    [500, 'InternalError', /S3 error InternalError \(HTTP 500\)/],
  ])('testConnection explains an HTTP %i %s', async (status, code, message) => {
    fake.errorResponse = { status, code };
    await expect(makeDestination().testConnection()).rejects.toThrow(message);
  });

  it('testConnection names the region an AuthorizationHeaderMalformed error says the bucket is in', async () => {
    fake.errorResponse = {
      status: 400,
      code: 'AuthorizationHeaderMalformed',
      fields: {
        Message: "The authorization header is malformed; the region 'us-east-1' is wrong",
        Region: 'eu-west-1',
      },
    };
    await expect(makeDestination().testConnection()).rejects.toThrow(
      'The bucket is in region "eu-west-1", not "us-east-1" — set Region to eu-west-1.',
    );
  });

  it('never echoes what AWS sends back on SignatureDoesNotMatch (StringToSign, CanonicalRequest, key id)', async () => {
    const MARKER = 'ECHOxMARKERx42';
    fake.errorResponse = {
      status: 403,
      code: 'SignatureDoesNotMatch',
      fields: {
        Message: `The request signature we calculated does not match the signature you provided. ${MARKER}`,
        AWSAccessKeyId: `AKIA${MARKER}`,
        StringToSign: `AWS4-HMAC-SHA256\n20260101T000000Z\n20260101/us-east-1/s3/aws4_request\n${MARKER}`,
        SignatureProvided: MARKER,
        StringToSignBytes: `41 57 53 ${MARKER}`,
        CanonicalRequest: `GET\n/backups-bucket\nlist-type=2&max-keys=0\nhost:${MARKER}`,
        CanonicalRequestBytes: `47 45 54 ${MARKER}`,
        RequestId: MARKER,
        HostId: MARKER,
      },
    };
    const failure = makeDestination().testConnection();
    await expect(failure).rejects.toThrow(/rejected the request signature/);
    await expect(failure).rejects.not.toThrow(new RegExp(MARKER));
  });

  it('does not echo an error field that is not a short token (free text in Code, Region or BucketName)', async () => {
    const MARKER = 'ECHOxMARKERx43';
    fake.errorResponse = {
      status: 400,
      code: 'AuthorizationHeaderMalformed',
      fields: { Region: `eu-west-1 ${MARKER}`, BucketName: `other bucket ${MARKER}` },
    };
    const regionFailure = makeDestination().testConnection();
    await expect(regionFailure).rejects.toThrow(/rejected the region/);
    await expect(regionFailure).rejects.not.toThrow(new RegExp(MARKER));

    fake.errorResponse = { status: 403, code: `Denied <b>${MARKER}</b>` };
    const codeFailure = makeDestination().testConnection();
    await expect(codeFailure).rejects.toThrow(
      /Could not reach the S3 bucket "backups-bucket" \(HTTP 403\)/,
    );
    await expect(codeFailure).rejects.not.toThrow(new RegExp(MARKER));
  });

  it('testConnection refuses a 200 that is not an S3 bucket listing (e.g. a web page)', async () => {
    const web = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Dashboard</title>');
    });
    await new Promise<void>((resolve) => web.listen(0, '127.0.0.1', resolve));
    const address = web.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      const dest = makeDestination({ endpoint: `http://127.0.0.1:${port}` });
      await expect(dest.testConnection()).rejects.toThrow(/not as an S3 API/);
    } finally {
      await new Promise<void>((resolve) => web.close(() => resolve()));
    }
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

  it('keeps a legacy stored bucket name with URL metacharacters inside its own path segment', async () => {
    // The schema refuses such names now; one stored before must still never
    // turn into a fragment/query that re-targets the request.
    const dest = makeDestination({ bucket: 'legacy#bucket' });
    const key = backupObjectKey('backups', 'bkp_legacy');
    const payload = Buffer.from('legacy bucket archive');
    const src = await writeFixture('legacy.tar', payload);

    await dest.upload({ key, filePath: src, sizeBytes: payload.length });

    expect([...fake.objects.keys()]).toEqual([key]);
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

  describe('delete is permanent', () => {
    async function uploadTwice(dest: S3Destination, key: string): Promise<void> {
      const src = await writeFixture('v.tar', Buffer.from('version one'));
      await dest.upload({ key, filePath: src, sizeBytes: 11 });
      const src2 = await writeFixture('v2.tar', Buffer.from('version two!'));
      await dest.upload({ key, filePath: src2, sizeBytes: 12 });
    }

    it('removes every stored version on a versioned bucket, not just the current one', async () => {
      fake.versioning = true;
      const dest = makeDestination();
      const key = backupObjectKey('backups', 'bkp_versioned');
      const neighbour = backupObjectKey('backups', 'bkp_versioned2');
      await uploadTwice(dest, key);
      fake.objects.set(neighbour, Buffer.from('another backup sharing the prefix'));
      expect(fake.versions.get(key)).toHaveLength(2);

      await dest.delete(key);

      expect(fake.objects.has(key)).toBe(false);
      // No version and no delete marker left — a plain DELETE would have left both versions plus a marker.
      expect(fake.versions.has(key)).toBe(false);
      expect(fake.objects.has(neighbour)).toBe(true);
    });

    it('also clears a delete marker an earlier plain delete left behind', async () => {
      fake.versioning = true;
      const dest = makeDestination();
      const key = backupObjectKey('backups', 'bkp_marked');
      await uploadTwice(dest, key);
      fake.versions.get(key)!.push({ versionId: 'marker-1', body: null });
      fake.objects.delete(key);

      await dest.delete(key);

      expect(fake.versions.has(key)).toBe(false);
    });

    it('follows ListObjectVersions pagination', async () => {
      fake.versioning = true;
      fake.versionsPageSize = 1;
      const dest = makeDestination();
      const key = backupObjectKey('backups', 'bkp_paged');
      await uploadTwice(dest, key);
      const src = await writeFixture('v3.tar', Buffer.from('version three'));
      await dest.upload({ key, filePath: src, sizeBytes: 13 });

      await dest.delete(key);

      expect(fake.versions.has(key)).toBe(false);
    });

    it('deletes an unversioned object through its null version', async () => {
      const dest = makeDestination();
      const key = backupObjectKey('backups', 'bkp_plain');
      fake.objects.set(key, Buffer.from('archive'));

      await dest.delete(key);

      expect(fake.objects.has(key)).toBe(false);
    });

    it('falls back to a plain delete on a provider without a versioning API', async () => {
      fake.versionsApi = 'not-implemented';
      const dest = makeDestination();
      const key = backupObjectKey('backups', 'bkp_noversions');
      fake.objects.set(key, Buffer.from('archive'));

      await dest.delete(key);

      expect(fake.objects.has(key)).toBe(false);
    });

    it('refuses, naming the permission, when listing versions is denied', async () => {
      fake.versionsApi = 'access-denied';
      const dest = makeDestination();
      const key = backupObjectKey('backups', 'bkp_denied');
      fake.objects.set(key, Buffer.from('archive'));

      await expect(dest.delete(key)).rejects.toThrow(/s3:ListBucketVersions/);
      expect(fake.objects.has(key)).toBe(true);
    });

    it('reports versions an Object Lock keeps, instead of claiming success', async () => {
      fake.versioning = true;
      const dest = makeDestination();
      const key = backupObjectKey('backups', 'bkp_locked');
      await uploadTwice(dest, key);
      fake.lockedVersions.add(fake.versions.get(key)![0]!.versionId);

      await expect(dest.delete(key)).rejects.toThrow(/s3:DeleteObjectVersion/);
    });

    it('is a no-op for a key that does not exist', async () => {
      fake.versioning = true;
      await expect(
        makeDestination().delete(backupObjectKey('backups', 'bkp_absent')),
      ).resolves.toBeUndefined();
      expect(fake.versions.size).toBe(0);
    });
  });

  it('download of a missing key throws NOT_FOUND', async () => {
    const dest = makeDestination();
    await expect(dest.download('backups/bkp_missing.tar', join(workDir, 'x.tar'))).rejects.toThrow(
      /No object/,
    );
  });
});
