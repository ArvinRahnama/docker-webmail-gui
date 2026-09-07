/**
 * SQL access for the single-row `backup_destination` config (migration 007)
 * and its pre-change snapshots. The stored config includes the secret access
 * key (the server must present it to the S3 signer); masking happens one layer
 * up in the service, never here. The row is created lazily on first read.
 */
import type { BackupDestinationType } from '@dwg/shared';
import type { Database } from '../../platform/db.js';
import { generateId } from '../../platform/errors.js';

export interface StoredS3Config {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  /** The real secret access key — stored so the signer can use it, never returned by a masked read path. */
  readonly secretAccessKey: string;
  readonly prefix: string;
}

export interface StoredFtpConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  /** The real password — stored so the client can log in, never returned by a masked read path. */
  readonly password: string;
  readonly secure: boolean;
  readonly path: string;
}

export interface StoredDestinationConfig {
  readonly type: BackupDestinationType;
  readonly s3: StoredS3Config | null;
  readonly ftp: StoredFtpConfig | null;
  readonly updatedAt: string;
}

interface DestinationRow {
  readonly type: string;
  readonly s3_endpoint: string | null;
  readonly s3_region: string | null;
  readonly s3_bucket: string | null;
  readonly s3_access_key_id: string | null;
  readonly s3_secret_access_key: string | null;
  readonly s3_prefix: string;
  readonly ftp_host: string | null;
  readonly ftp_port: number | null;
  readonly ftp_user: string | null;
  readonly ftp_password: string | null;
  readonly ftp_path: string | null;
  readonly ftp_secure: number | null;
  readonly updated_at: string;
}

function toStored(row: DestinationRow): StoredDestinationConfig {
  if (
    row.type === 's3' &&
    row.s3_endpoint !== null &&
    row.s3_region !== null &&
    row.s3_bucket !== null &&
    row.s3_access_key_id !== null
  ) {
    return {
      type: 's3',
      s3: {
        endpoint: row.s3_endpoint,
        region: row.s3_region,
        bucket: row.s3_bucket,
        accessKeyId: row.s3_access_key_id,
        secretAccessKey: row.s3_secret_access_key ?? '',
        prefix: row.s3_prefix,
      },
      ftp: null,
      updatedAt: row.updated_at,
    };
  }
  if (
    row.type === 'ftp' &&
    row.ftp_host !== null &&
    row.ftp_port !== null &&
    row.ftp_user !== null
  ) {
    return {
      type: 'ftp',
      s3: null,
      ftp: {
        host: row.ftp_host,
        port: row.ftp_port,
        user: row.ftp_user,
        password: row.ftp_password ?? '',
        secure: row.ftp_secure !== 0 && row.ftp_secure !== null,
        path: row.ftp_path ?? '',
      },
      updatedAt: row.updated_at,
    };
  }
  return { type: 'none', s3: null, ftp: null, updatedAt: row.updated_at };
}

export interface DestinationSnapshotParams {
  readonly createdByAdminId: string | null;
  readonly createdByLabel: string;
  readonly configJson: string;
}

export class BackupDestinationConfigRepository {
  constructor(private readonly db: Database) {}

  get(): StoredDestinationConfig {
    const existing = this.db.get<DestinationRow>('SELECT * FROM backup_destination WHERE id = 1');
    if (existing !== undefined) return toStored(existing);
    this.db.run(
      `INSERT INTO backup_destination (id, type, s3_prefix, updated_at) VALUES (1, 'none', '', ?)`,
      [new Date().toISOString()],
    );
    return this.getOrThrow();
  }

  setNone(): void {
    this.get();
    this.db.run(
      `UPDATE backup_destination
          SET type = 'none', s3_endpoint = NULL, s3_region = NULL, s3_bucket = NULL,
              s3_access_key_id = NULL, s3_secret_access_key = NULL, s3_prefix = '',
              ftp_host = NULL, ftp_port = NULL, ftp_user = NULL, ftp_password = NULL,
              ftp_path = NULL, ftp_secure = NULL, updated_at = ?
        WHERE id = 1`,
      [new Date().toISOString()],
    );
  }

  setS3(config: StoredS3Config): void {
    this.get();
    this.db.run(
      `UPDATE backup_destination
          SET type = 's3', s3_endpoint = ?, s3_region = ?, s3_bucket = ?,
              s3_access_key_id = ?, s3_secret_access_key = ?, s3_prefix = ?,
              ftp_host = NULL, ftp_port = NULL, ftp_user = NULL, ftp_password = NULL,
              ftp_path = NULL, ftp_secure = NULL, updated_at = ?
        WHERE id = 1`,
      [
        config.endpoint,
        config.region,
        config.bucket,
        config.accessKeyId,
        config.secretAccessKey,
        config.prefix,
        new Date().toISOString(),
      ],
    );
  }

  setFtp(config: StoredFtpConfig): void {
    this.get();
    this.db.run(
      `UPDATE backup_destination
          SET type = 'ftp', s3_endpoint = NULL, s3_region = NULL, s3_bucket = NULL,
              s3_access_key_id = NULL, s3_secret_access_key = NULL, s3_prefix = '',
              ftp_host = ?, ftp_port = ?, ftp_user = ?, ftp_password = ?, ftp_path = ?,
              ftp_secure = ?, updated_at = ?
        WHERE id = 1`,
      [
        config.host,
        config.port,
        config.user,
        config.password,
        config.path,
        config.secure ? 1 : 0,
        new Date().toISOString(),
      ],
    );
  }

  insertSnapshot(params: DestinationSnapshotParams): void {
    this.db.run(
      `INSERT INTO backup_destination_snapshots (id, created_at, created_by_admin_id, created_by_label, config_json)
       VALUES (?, ?, ?, ?, ?)`,
      [
        generateId('bds'),
        new Date().toISOString(),
        params.createdByAdminId,
        params.createdByLabel,
        params.configJson,
      ],
    );
  }

  snapshotCount(): number {
    const row = this.db.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM backup_destination_snapshots',
    );
    return row?.count ?? 0;
  }

  private getOrThrow(): StoredDestinationConfig {
    const row = this.db.get<DestinationRow>('SELECT * FROM backup_destination WHERE id = 1');
    if (row === undefined) {
      throw new Error('BackupDestinationConfigRepository: singleton row missing after write');
    }
    return toStored(row);
  }
}
