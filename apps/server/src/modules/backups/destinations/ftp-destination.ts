/**
 * FTP/FTPS {@link BackupDestination} — the second destination type, behind the
 * same interface the S3 one implements, built on the `basic-ftp` client through
 * the `ftp-client.ts` seam.
 *
 * Design mirrors `S3Destination`: one connection per operation (basic-ftp's
 * `Client` is not concurrency-safe, and a fresh connection per call is simplest
 * and leak-free with a `finally` close), keys are full remote paths under a
 * configured base directory, and `list()` returns only our `.tar` objects,
 * newest first.
 *
 * **Resumable upload.** basic-ftp's high-level upload (`uploadFrom`) issues a
 * plain `STOR`; it does not emit `REST` before `STOR`. The clean way to
 * continue an interrupted upload with this client is `appendFrom` (`APPE`),
 * which appends only the not-yet-sent bytes. So: if a strictly smaller partial
 * already exists on the remote, we `APPE` the remainder from that offset;
 * otherwise (nothing there, an equal-size file that may be stale, or a larger
 * one) we `STOR` cleanly from scratch. This is the "resume if a partial exists,
 * else clean re-send" the FTP requirement allows — via APPE rather than
 * REST+STOR, stated plainly because basic-ftp does not support the latter.
 *
 * Runs in the server tier: plain FTP(S) to a remote store, no broker op, no
 * Docker socket, no client-supplied path (the key is derived from a backup id
 * and the configured base path). The password lives only in the connection
 * config handed to basic-ftp and is never logged.
 */
import { rm } from 'node:fs/promises';
import type { Client } from 'basic-ftp';
import { AppError } from '../../../platform/errors.js';
import {
  backupIdFromKey,
  backupObjectKey,
  type BackupDestination,
  type RemoteBackup,
  type UploadParams,
} from './destination.js';
import { connectFtp, type FtpConnectionConfig } from './ftp-client.js';

export interface FtpDestinationConfig extends FtpConnectionConfig {
  /** Remote base directory backups live under (e.g. `/backups` or `backups`). */
  readonly path: string;
}

function isMissingFileError(error: unknown): boolean {
  // basic-ftp throws an FTPError carrying the numeric reply code; 550 is
  // "file unavailable / not found".
  return (
    typeof (error as { code?: number }).code === 'number' &&
    (error as { code: number }).code === 550
  );
}

export class FtpDestination implements BackupDestination {
  readonly type = 'ftp' as const;

  private readonly basePath: string;

  constructor(private readonly config: FtpDestinationConfig) {
    const trimmed = config.path.replace(/^\/+|\/+$/g, '');
    this.basePath = trimmed === '' ? '' : `/${trimmed}`;
  }

  get describe(): string {
    return `ftp://${this.config.host}${this.basePath}/`;
  }

  keyForBackup(backupId: string): string {
    return backupObjectKey(this.basePath, backupId);
  }

  private async withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    let client: Client;
    try {
      client = await connectFtp(this.config);
    } catch (error) {
      throw new AppError(
        'UPSTREAM_UNAVAILABLE',
        `Could not connect to the FTP server ${this.config.host}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
    try {
      return await fn(client);
    } finally {
      client.close();
    }
  }

  async testConnection(): Promise<void> {
    await this.withClient(async (client) => {
      // A successful access() already proves connectivity + auth; ensuring the
      // base directory exists also surfaces a wrong path early.
      if (this.basePath !== '') await client.ensureDir(this.basePath);
    });
  }

  async list(): Promise<readonly RemoteBackup[]> {
    return this.withClient(async (client) => {
      let infos;
      try {
        infos = await client.list(this.basePath === '' ? undefined : this.basePath);
      } catch (error) {
        if (isMissingFileError(error)) return []; // base dir not created yet
        throw error;
      }
      const prefix = this.basePath === '' ? '' : `${this.basePath}/`;
      const backups: RemoteBackup[] = [];
      for (const info of infos) {
        const key = `${prefix}${info.name}`;
        if (backupIdFromKey(key) === null) continue;
        backups.push({
          key,
          sizeBytes: info.size,
          lastModified: (info.modifiedAt ?? new Date(0)).toISOString(),
        });
      }
      backups.sort(
        (a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime(),
      );
      return backups;
    });
  }

  async upload(params: UploadParams): Promise<void> {
    await this.withClient(async (client) => {
      if (this.basePath !== '') await client.ensureDir(this.basePath);

      let remoteSize = 0;
      try {
        remoteSize = await client.size(params.key);
      } catch {
        remoteSize = 0; // not present yet
      }

      if (remoteSize > 0 && remoteSize < params.sizeBytes) {
        // Resume: append only the bytes not yet transferred.
        await client.appendFrom(params.filePath, params.key, { localStart: remoteSize });
      } else {
        await client.uploadFrom(params.filePath, params.key);
      }
    });
  }

  async download(key: string, destPath: string): Promise<void> {
    try {
      await this.withClient((client) => client.downloadTo(destPath, key));
    } catch (error) {
      // Don't leave a partial file staged on a failed/absent download.
      await rm(destPath, { force: true }).catch(() => undefined);
      if (isMissingFileError(error)) {
        throw new AppError('NOT_FOUND', `No object "${key}" exists on the remote.`);
      }
      throw error instanceof AppError
        ? error
        : new AppError('UPSTREAM_UNAVAILABLE', `FTP download failed: ${String(error)}`);
    }
  }

  async delete(key: string): Promise<void> {
    await this.withClient(async (client) => {
      try {
        await client.remove(key);
      } catch (error) {
        if (isMissingFileError(error)) return; // already gone — deletion is idempotent
        throw error;
      }
    });
  }

  cleanupInterruptedUploads(): Promise<void> {
    // FTP has no multipart-upload concept to sweep: an interrupted STOR leaves a
    // single partial file, which `upload`'s resume path (APPE from the current
    // size) continues on the next attempt. Nothing to clean up here.
    return Promise.resolve();
  }
}
