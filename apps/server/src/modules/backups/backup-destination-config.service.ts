/**
 * The destination config's read/update surface, with the secrets discipline
 * the guardrail requires (the secret is the S3 secret access key, or the FTP
 * password, depending on type):
 *  - **masked reads**: `getStatus` never carries the secret — only a boolean
 *    saying one is stored, plus the non-secret identifier (S3 access key id, or
 *    FTP host/user).
 *  - **audited reveal**: `revealSecret` is the one path that returns the real
 *    secret, and it writes a `config.reveal_secret` audit row.
 *  - **pre-change snapshot**: every `update` first snapshots the prior config
 *    into `backup_destination_snapshots` — with the secret (S3 secret access
 *    key or FTP password) redacted, since the live config row already holds
 *    it and a second plaintext copy in a history table is an avoidable
 *    exposure — then audits the change as `config.apply`.
 *
 * `resolve()` is the server-internal accessor the destination factory uses; it
 * returns the secret because the signer/client needs it, never a response body.
 */
import type {
  BackupDestinationStatus,
  BackupDestinationSecretResponse,
  BackupDestinationUpdate,
} from '@dwg/shared';
import { recordAuditEvent } from '../../platform/audit.js';
import type { Database } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import type { ResolvedDestination } from './destinations/destination.service.js';
import { BackupDestinationConfigRepository } from './backup-destination-config.repository.js';

export interface DestinationConfigActor {
  readonly adminId: string | null;
  readonly label: string;
}

export class BackupDestinationConfigService {
  constructor(
    private readonly repository: BackupDestinationConfigRepository,
    private readonly db: Database,
  ) {}

  /** Masked, non-secret view for the Settings UI. */
  getStatus(): BackupDestinationStatus {
    const stored = this.repository.get();
    if (stored.type === 's3' && stored.s3 !== null) {
      return {
        type: 's3',
        configured: stored.s3.secretAccessKey !== '',
        describe: `s3://${stored.s3.bucket}/${stored.s3.prefix}`,
        s3: {
          endpoint: stored.s3.endpoint,
          region: stored.s3.region,
          bucket: stored.s3.bucket,
          prefix: stored.s3.prefix,
          accessKeyId: stored.s3.accessKeyId,
          secretAccessKeySet: stored.s3.secretAccessKey !== '',
        },
        ftp: null,
      };
    }
    if (stored.type === 'ftp' && stored.ftp !== null) {
      return {
        type: 'ftp',
        configured: stored.ftp.password !== '',
        describe: `ftp://${stored.ftp.host}/${stored.ftp.path}`,
        s3: null,
        ftp: {
          host: stored.ftp.host,
          port: stored.ftp.port,
          path: stored.ftp.path,
          user: stored.ftp.user,
          secure: stored.ftp.secure,
          passwordSet: stored.ftp.password !== '',
        },
      };
    }
    return { type: 'none', configured: false, describe: null, s3: null, ftp: null };
  }

  /** Server-internal: the resolved settings the destination factory builds from. Includes the secret; never a response body. */
  resolve(): ResolvedDestination {
    const stored = this.repository.get();
    if (stored.type === 's3' && stored.s3 !== null && stored.s3.secretAccessKey !== '') {
      return { type: 's3', s3: { ...stored.s3 } };
    }
    if (stored.type === 'ftp' && stored.ftp !== null && stored.ftp.password !== '') {
      return { type: 'ftp', ftp: { ...stored.ftp } };
    }
    return { type: 'none' };
  }

  update(update: BackupDestinationUpdate, actor: DestinationConfigActor): void {
    // Pre-change snapshot (secret redacted) BEFORE any write.
    this.snapshotPrior(actor);

    if (update.type === 'none') {
      this.repository.setNone();
    } else if (update.type === 's3') {
      const existing = this.repository.get();
      const existingSecret = existing.s3?.secretAccessKey ?? '';
      // Omitting the secret keeps the stored one; it must resolve to something.
      const secretAccessKey = update.secretAccessKey ?? existingSecret;
      if (secretAccessKey === '') {
        throw new AppError('VALIDATION_FAILED', 'A secret access key is required for S3.');
      }
      this.repository.setS3({
        endpoint: update.endpoint,
        region: update.region,
        bucket: update.bucket,
        accessKeyId: update.accessKeyId,
        secretAccessKey,
        prefix: update.prefix,
      });
    } else {
      const existing = this.repository.get();
      const existingPassword = existing.ftp?.password ?? '';
      // Omitting the password keeps the stored one, exactly like the S3 secret.
      const password = update.password ?? existingPassword;
      if (password === '') {
        throw new AppError('VALIDATION_FAILED', 'A password is required for FTP.');
      }
      this.repository.setFtp({
        host: update.host,
        port: update.port,
        user: update.user,
        password,
        secure: update.secure,
        path: update.path,
      });
    }

    recordAuditEvent(this.db, {
      actor: { adminId: actor.adminId, label: actor.label },
      action: 'config.apply',
      target: { type: 'config', id: 'backup_destination' },
      result: 'success',
      ip: null,
      userAgent: null,
      details: { setting: 'backup_destination', type: update.type },
    });
  }

  /** The one path that returns the real secret (S3 secret key or FTP password) — audited as a secret reveal. */
  revealSecret(actor: DestinationConfigActor): BackupDestinationSecretResponse {
    const stored = this.repository.get();
    const value = stored.s3?.secretAccessKey ?? stored.ftp?.password ?? null;

    recordAuditEvent(this.db, {
      actor: { adminId: actor.adminId, label: actor.label },
      action: 'config.reveal_secret',
      target: { type: 'config', id: 'backup_destination_secret' },
      result: 'success',
      ip: null,
      userAgent: null,
      details: { setting: 'backup_destination' },
    });

    return { value: value === '' ? null : value };
  }

  private snapshotPrior(actor: DestinationConfigActor): void {
    const prior = this.repository.get();
    // The pre-change snapshot records the prior config for provenance and a
    // future rollback, but NOT the plaintext secret: the live config row
    // already holds it (it must, to authenticate), so there is no reason to
    // keep a second plaintext copy in a history table. A rollback restores the
    // non-secret fields and re-prompts for the secret. Everything else is kept
    // verbatim so host/bucket/user/etc. remain fully recoverable.
    const redacted = {
      ...prior,
      s3:
        prior.s3 === null
          ? null
          : {
              ...prior.s3,
              secretAccessKey: prior.s3.secretAccessKey === '' ? '' : REDACTED_SECRET,
            },
      ftp:
        prior.ftp === null
          ? null
          : { ...prior.ftp, password: prior.ftp.password === '' ? '' : REDACTED_SECRET },
    };
    this.repository.insertSnapshot({
      createdByAdminId: actor.adminId,
      createdByLabel: actor.label,
      configJson: JSON.stringify(redacted),
    });
  }
}

/** Placeholder written into a snapshot in place of a real secret — never a value that could be mistaken for one. */
const REDACTED_SECRET = '***REDACTED***';
