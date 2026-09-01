/**
 * Builds the currently-configured {@link BackupDestination} from settings, or
 * reports that none is configured. This is the one place that turns stored
 * connection settings into a live destination object, so the uploader and the
 * routes never construct an `S3Destination` (or, later, an FTP one) directly.
 *
 * The settings themselves come from the allowlisted config store (wired in a
 * later chunk); this service takes a `resolve` callback so it stays testable
 * with a plain in-memory settings source and never reaches into config
 * loading itself. Secrets live only inside the resolved settings and the
 * destination's signer — never logged here.
 */
import { AppError } from '../../../platform/errors.js';
import type { BackupDestination } from './destination.js';
import { S3Destination, type S3DestinationConfig } from './s3-destination.js';

export interface S3DestinationSettings {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly prefix: string;
}

/** The destination the operator has configured, resolved from settings. `none` means the VPS is the only storage. */
export type ResolvedDestination =
  { readonly type: 's3'; readonly s3: S3DestinationSettings } | { readonly type: 'none' };

/** Non-user construction overrides — a small multipart part size and an injected clock, for tests. */
export type S3ConstructionOverrides = Partial<
  Pick<S3DestinationConfig, 'partSizeBytes' | 'multipartThresholdBytes' | 'now'>
>;

export interface DestinationServiceDeps {
  readonly resolve: () => ResolvedDestination;
  readonly s3Overrides?: S3ConstructionOverrides;
}

export class DestinationService {
  constructor(private readonly deps: DestinationServiceDeps) {}

  /** The configured destination, or `null` when none is configured (VPS-only storage). */
  current(): BackupDestination | null {
    const settings = this.deps.resolve();
    if (settings.type === 's3') {
      return new S3Destination({ ...settings.s3, ...(this.deps.s3Overrides ?? {}) });
    }
    return null;
  }

  isConfigured(): boolean {
    return this.deps.resolve().type !== 'none';
  }

  /** Verifies the configured destination is reachable — backs the "test connection" action. Throws if nothing is configured, or if the check fails. */
  async testConnection(): Promise<void> {
    const destination = this.current();
    if (destination === null) {
      throw new AppError('VALIDATION_FAILED', 'No remote destination is configured.');
    }
    await destination.testConnection();
  }
}
