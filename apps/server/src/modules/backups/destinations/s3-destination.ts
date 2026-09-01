/**
 * S3 {@link BackupDestination} — speaks the S3 REST API directly over
 * `undici` (already budgeted) with a hand-rolled SigV4 signer (`sigv4.ts`).
 * **No AWS SDK**, per the dependency budget.
 *
 * Path-style addressing (`<endpoint>/<bucket>/<key>`) throughout, so it works
 * unchanged against AWS S3, S3-compatible stores (MinIO, Backblaze B2,
 * Cloudflare R2), and the in-process test fake — none of which need a
 * per-host special case.
 *
 * Uploads: files at or below the multipart threshold go in a single PUT;
 * larger ones use a multipart upload with per-part retry, aborting the whole
 * multipart on unrecoverable failure so a half-finished upload never lingers
 * as billable orphaned parts (`cleanupInterruptedUploads` sweeps any that a
 * crash still left behind). The *whole-backup* retry ("re-upload without
 * re-taking the backup") lives one level up in the uploader — this class just
 * makes one attempt fully succeed or fully fail.
 *
 * Secrets discipline: the secret key lives only inside the signer's HMAC
 * chain; this class never logs a URL, header, or credential, and `describe`
 * is deliberately credential-free.
 */
import { createWriteStream } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { request } from 'undici';
import { AppError } from '../../../platform/errors.js';
import {
  backupIdFromKey,
  backupObjectKey,
  type BackupDestination,
  type RemoteBackup,
  type UploadParams,
} from './destination.js';
import { EMPTY_PAYLOAD_SHA256, sha256Hex, signRequestV4, type SigV4Credentials } from './sigv4.js';

export interface S3DestinationConfig {
  /** Base endpoint, e.g. `https://s3.us-east-1.amazonaws.com` or `http://127.0.0.1:1234`. No bucket, no trailing slash required. */
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Key prefix within the bucket (e.g. `backups`), or `''`. */
  readonly prefix: string;
  /** Part size, and the size above which multipart is used. Production default; tests set it small to exercise multipart on tiny files. */
  readonly partSizeBytes?: number;
  /** Overrides the multipart cutover independently of part size, if needed. Defaults to `partSizeBytes`. */
  readonly multipartThresholdBytes?: number;
  /** Injectable clock, so signing is deterministic under test. */
  readonly now?: () => Date;
}

/** 64 MiB — comfortably above S3's 5 MiB minimum part size, and a reasonable resumable chunk. */
const DEFAULT_PART_SIZE_BYTES = 64 * 1024 * 1024;
const MAX_PART_ATTEMPTS = 3;
const HEADERS_TIMEOUT_MS = 30_000;
const BODY_TIMEOUT_MS = 15 * 60_000;

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function firstMatch(source: string, pattern: RegExp): string | null {
  const match = pattern.exec(source);
  return match ? xmlUnescape(match[1]!) : null;
}

interface UploadedPart {
  readonly partNumber: number;
  readonly etag: string;
}

export class S3Destination implements BackupDestination {
  readonly type = 's3' as const;

  private readonly endpoint: string;
  private readonly partSize: number;
  private readonly multipartThreshold: number;
  private readonly nowFn: () => Date;

  constructor(private readonly config: S3DestinationConfig) {
    this.endpoint = config.endpoint.replace(/\/+$/, '');
    this.partSize = config.partSizeBytes ?? DEFAULT_PART_SIZE_BYTES;
    this.multipartThreshold = config.multipartThresholdBytes ?? this.partSize;
    this.nowFn = config.now ?? ((): Date => new Date());
  }

  get describe(): string {
    return `s3://${this.config.bucket}/${this.config.prefix}`;
  }

  keyForBackup(backupId: string): string {
    return backupObjectKey(this.config.prefix, backupId);
  }

  private get credentials(): SigV4Credentials {
    return {
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      region: this.config.region,
      service: 's3',
    };
  }

  private objectUrl(key: string, params?: Record<string, string>): URL {
    const url = new URL(`${this.endpoint}/${this.config.bucket}/${key}`);
    for (const [name, value] of Object.entries(params ?? {})) url.searchParams.set(name, value);
    return url;
  }

  private bucketUrl(params?: Record<string, string>): URL {
    const url = new URL(`${this.endpoint}/${this.config.bucket}`);
    for (const [name, value] of Object.entries(params ?? {})) url.searchParams.set(name, value);
    return url;
  }

  private async send(
    method: string,
    url: URL,
    options: { body?: Buffer; extraHeaders?: Record<string, string> } = {},
  ): ReturnType<typeof request> {
    const payloadSha256 =
      options.body !== undefined ? sha256Hex(options.body) : EMPTY_PAYLOAD_SHA256;
    const headers = signRequestV4(
      {
        method,
        url,
        payloadSha256,
        ...(options.extraHeaders ? { headers: options.extraHeaders } : {}),
      },
      this.credentials,
      this.nowFn(),
    );
    return request(url, {
      method: method as 'GET',
      headers,
      ...(options.body !== undefined ? { body: options.body } : {}),
      headersTimeout: HEADERS_TIMEOUT_MS,
      bodyTimeout: BODY_TIMEOUT_MS,
    });
  }

  private static ok(statusCode: number): boolean {
    return statusCode >= 200 && statusCode < 300;
  }

  async testConnection(): Promise<void> {
    const response = await this.send('GET', this.bucketUrl({ 'list-type': '2', 'max-keys': '0' }));
    await response.body.dump();
    if (!S3Destination.ok(response.statusCode)) {
      throw new AppError(
        'UPSTREAM_UNAVAILABLE',
        `Could not reach the S3 bucket "${this.config.bucket}" (HTTP ${response.statusCode}). Check the endpoint, region, bucket name and credentials.`,
      );
    }
  }

  async list(): Promise<readonly RemoteBackup[]> {
    const response = await this.send(
      'GET',
      this.bucketUrl({ 'list-type': '2', prefix: this.config.prefix }),
    );
    const xml = await response.body.text();
    if (!S3Destination.ok(response.statusCode)) {
      throw new AppError('UPSTREAM_UNAVAILABLE', `S3 list failed (HTTP ${response.statusCode}).`);
    }

    const backups: RemoteBackup[] = [];
    for (const block of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const body = block[1]!;
      const key = firstMatch(body, /<Key>([\s\S]*?)<\/Key>/);
      if (key === null || backupIdFromKey(key) === null) continue; // ignore non-backup objects
      backups.push({
        key,
        sizeBytes: Number(firstMatch(body, /<Size>([\s\S]*?)<\/Size>/) ?? '0'),
        lastModified: firstMatch(body, /<LastModified>([\s\S]*?)<\/LastModified>/) ?? '',
      });
    }
    // Newest first, so retention and the restore-from-remote picker agree on order.
    backups.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
    return backups;
  }

  async upload(params: UploadParams): Promise<void> {
    if (params.sizeBytes > this.multipartThreshold) {
      await this.multipartUpload(params);
    } else {
      await this.singlePartUpload(params);
    }
  }

  private async singlePartUpload(params: UploadParams): Promise<void> {
    const body = await readFile(params.filePath);
    const response = await this.send('PUT', this.objectUrl(params.key), {
      body,
      extraHeaders: { 'content-type': 'application/x-tar' },
    });
    await response.body.dump();
    if (!S3Destination.ok(response.statusCode)) {
      throw new AppError('UPSTREAM_UNAVAILABLE', `S3 upload failed (HTTP ${response.statusCode}).`);
    }
  }

  private async multipartUpload(params: UploadParams): Promise<void> {
    const uploadId = await this.createMultipart(params.key);
    try {
      const parts: UploadedPart[] = [];
      const handle = await open(params.filePath, 'r');
      try {
        let partNumber = 1;
        let offset = 0;
        while (offset < params.sizeBytes) {
          const size = Math.min(this.partSize, params.sizeBytes - offset);
          const buffer = Buffer.alloc(size);
          await handle.read(buffer, 0, size, offset);
          parts.push({
            partNumber,
            etag: await this.uploadPartWithRetry(params.key, uploadId, partNumber, buffer),
          });
          offset += size;
          partNumber += 1;
        }
      } finally {
        await handle.close();
      }
      await this.completeMultipart(params.key, uploadId, parts);
    } catch (error) {
      // Leave no orphaned parts behind on a failed attempt.
      await this.abortMultipart(params.key, uploadId).catch(() => undefined);
      throw error;
    }
  }

  private async createMultipart(key: string): Promise<string> {
    const response = await this.send('POST', this.objectUrl(key, { uploads: '' }), {
      extraHeaders: { 'content-type': 'application/x-tar' },
    });
    const xml = await response.body.text();
    if (!S3Destination.ok(response.statusCode)) {
      throw new AppError(
        'UPSTREAM_UNAVAILABLE',
        `S3 multipart initiation failed (HTTP ${response.statusCode}).`,
      );
    }
    const uploadId = firstMatch(xml, /<UploadId>([\s\S]*?)<\/UploadId>/);
    if (uploadId === null) {
      throw new AppError('UPSTREAM_UNAVAILABLE', 'S3 multipart initiation returned no UploadId.');
    }
    return uploadId;
  }

  private async uploadPartWithRetry(
    key: string,
    uploadId: string,
    partNumber: number,
    buffer: Buffer,
  ): Promise<string> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_PART_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.send(
          'PUT',
          this.objectUrl(key, { partNumber: String(partNumber), uploadId }),
          { body: buffer },
        );
        const etag = firstHeader(response.headers['etag']);
        await response.body.dump();
        if (S3Destination.ok(response.statusCode) && etag !== undefined) {
          return etag;
        }
        lastError = new AppError(
          'UPSTREAM_UNAVAILABLE',
          `S3 upload of part ${partNumber} failed (HTTP ${response.statusCode}).`,
        );
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new AppError('UPSTREAM_UNAVAILABLE', `S3 upload of part ${partNumber} failed.`);
  }

  private async completeMultipart(
    key: string,
    uploadId: string,
    parts: readonly UploadedPart[],
  ): Promise<void> {
    const body = Buffer.from(
      `<CompleteMultipartUpload>${parts
        .map(
          (part) =>
            `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${part.etag}</ETag></Part>`,
        )
        .join('')}</CompleteMultipartUpload>`,
      'utf8',
    );
    const response = await this.send('POST', this.objectUrl(key, { uploadId }), {
      body,
      extraHeaders: { 'content-type': 'application/xml' },
    });
    const xml = await response.body.text();
    // S3 can answer 200 with an <Error> body if the parts do not assemble — treat that as a failure.
    if (!S3Destination.ok(response.statusCode) || xml.includes('<Error>')) {
      throw new AppError(
        'UPSTREAM_UNAVAILABLE',
        `S3 multipart completion failed (HTTP ${response.statusCode}).`,
      );
    }
  }

  private async abortMultipart(key: string, uploadId: string): Promise<void> {
    const response = await this.send('DELETE', this.objectUrl(key, { uploadId }));
    await response.body.dump();
  }

  async download(key: string, destPath: string): Promise<void> {
    const response = await this.send('GET', this.objectUrl(key));
    if (response.statusCode === 404) {
      await response.body.dump();
      throw new AppError('NOT_FOUND', `No object "${key}" exists on the remote.`);
    }
    if (!S3Destination.ok(response.statusCode)) {
      await response.body.dump();
      throw new AppError(
        'UPSTREAM_UNAVAILABLE',
        `S3 download failed (HTTP ${response.statusCode}).`,
      );
    }
    await pipeline(response.body, createWriteStream(destPath));
  }

  async delete(key: string): Promise<void> {
    const response = await this.send('DELETE', this.objectUrl(key));
    await response.body.dump();
    if (!S3Destination.ok(response.statusCode)) {
      throw new AppError('UPSTREAM_UNAVAILABLE', `S3 delete failed (HTTP ${response.statusCode}).`);
    }
  }

  async cleanupInterruptedUploads(): Promise<void> {
    const response = await this.send('GET', this.bucketUrl({ uploads: '' }));
    const xml = await response.body.text();
    if (!S3Destination.ok(response.statusCode)) return; // best-effort

    for (const block of xml.matchAll(/<Upload>([\s\S]*?)<\/Upload>/g)) {
      const body = block[1]!;
      const key = firstMatch(body, /<Key>([\s\S]*?)<\/Key>/);
      const uploadId = firstMatch(body, /<UploadId>([\s\S]*?)<\/UploadId>/);
      if (key !== null && uploadId !== null) {
        await this.abortMultipart(key, uploadId).catch(() => undefined);
      }
    }
  }
}
