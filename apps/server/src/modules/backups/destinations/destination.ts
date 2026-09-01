/**
 * The remote-destination abstraction. A destination is where a finished local
 * backup archive is uploaded to, listed on, pulled from, and pruned — the
 * uploader and the restore-from-remote flow talk only to this interface, so a
 * second protocol (FTP, planned) slots in behind it with no change to callers.
 *
 * Everything here runs in the **server tier**, never the broker: uploads and
 * downloads are plain HTTP/FTP from the app to a remote store, involving no
 * Docker socket and no broker operation. No method takes a client-supplied
 * path or URL — the object key is derived server-side from a backup id and the
 * configured prefix, and the local file path is the one the archive writer
 * already produced.
 */

export type DestinationType = 's3' | 'ftp';

/** One backup object as it exists on the remote — the key, its size, and when the remote says it was last modified. */
export interface RemoteBackup {
  /** Full object key / remote path, including the configured prefix. */
  readonly key: string;
  readonly sizeBytes: number;
  /** ISO-8601 as reported by the remote; used only for display and newest-first ordering. */
  readonly lastModified: string;
}

export interface UploadParams {
  /** Full remote key to write to (prefix already applied). */
  readonly key: string;
  /** Local archive path to read from — the file the archive writer produced. */
  readonly filePath: string;
  /** Size in bytes, known from the archive writer, used to choose single-part vs multipart. */
  readonly sizeBytes: number;
}

export interface BackupDestination {
  readonly type: DestinationType;
  /** A credential-free description for logs and the UI, e.g. `s3://bucket/prefix`. Never contains a key or password. */
  readonly describe: string;

  /** The remote key this destination would store `backupId` under — its own prefix applied. Keeps prefix knowledge inside the destination. */
  keyForBackup(backupId: string): string;

  /** Verifies the destination is reachable and the credentials work. Throws on failure; resolves on success. */
  testConnection(): Promise<void>;

  /** Lists backup objects under the configured prefix, newest first. */
  list(): Promise<readonly RemoteBackup[]>;

  /** Uploads a local archive to `key`. Chooses single-part or resumable multipart by size. Throws on failure, leaving no partial object. */
  upload(params: UploadParams): Promise<void>;

  /** Streams the object at `key` to `destPath`. Throws if the object does not exist or the transfer fails. */
  download(key: string, destPath: string): Promise<void>;

  /** Deletes the object at `key`. Used by remote retention, only after a newer backup is verified present. */
  delete(key: string): Promise<void>;

  /** Best-effort cleanup of interrupted/stale multipart uploads. A no-op for protocols without the concept. */
  cleanupInterruptedUploads(): Promise<void>;
}

/** Derives the remote object key for a backup id under a prefix: `<prefix><id>.tar`. */
export function backupObjectKey(prefix: string, backupId: string): string {
  const normalised = prefix === '' ? '' : prefix.endsWith('/') ? prefix : `${prefix}/`;
  return `${normalised}${backupId}.tar`;
}

/** The backup id embedded in a remote key produced by {@link backupObjectKey}, or `null` if the key is not one of ours. */
export function backupIdFromKey(key: string): string | null {
  const base = key.slice(key.lastIndexOf('/') + 1);
  if (!base.endsWith('.tar')) return null;
  const id = base.slice(0, -'.tar'.length);
  return id === '' ? null : id;
}
