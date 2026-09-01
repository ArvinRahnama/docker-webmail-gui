/**
 * The destination config's read/update surface, with the secrets discipline
 * the guardrail requires:
 *  - **masked reads**: `getStatus` never carries the secret access key — only
 *    a boolean saying one is stored, plus the non-secret access key id.
 *  - **audited reveal**: `revealSecret` is the one path that returns the real
 *    secret, and it writes a `config.reveal_secret` audit row.
 *  - **pre-change snapshot**: every `update` first snapshots the full prior
 *    config (secret included) into `backup_destination_snapshots`, then audits
 *    the change as `config.apply`.
 *
 * `resolve()` is the server-internal accessor the destination factory uses; it
 * returns the secret because the signer needs it, and is never a response body.
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
      };
    }
    return { type: 'none', configured: false, describe: null, s3: null };
  }

  /** Server-internal: the resolved settings the destination factory builds from. Includes the secret; never a response body. */
  resolve(): ResolvedDestination {
    const stored = this.repository.get();
    if (stored.type === 's3' && stored.s3 !== null && stored.s3.secretAccessKey !== '') {
      return { type: 's3', s3: { ...stored.s3 } };
    }
    return { type: 'none' };
  }

  update(update: BackupDestinationUpdate, actor: DestinationConfigActor): void {
    // Pre-change snapshot (secret included) BEFORE any write.
    this.snapshotPrior(actor);

    if (update.type === 'none') {
      this.repository.setNone();
    } else {
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

  /** The one path that returns the real secret — audited as a secret reveal. */
  revealSecret(actor: DestinationConfigActor): BackupDestinationSecretResponse {
    const stored = this.repository.get();
    const value = stored.s3?.secretAccessKey ?? null;

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
    this.repository.insertSnapshot({
      createdByAdminId: actor.adminId,
      createdByLabel: actor.label,
      configJson: JSON.stringify(prior),
    });
  }
}
