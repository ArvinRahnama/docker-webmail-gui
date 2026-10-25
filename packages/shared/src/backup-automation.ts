/**
 * Backup automation (M13) — the shared contract for two features layered on
 * top of M10's manual backups (`backups.ts`):
 *
 *  1. **Scheduled automatic backups** — a persisted policy (off / daily /
 *     every-3-days / weekly / monthly) that a server-side timer arms and
 *     re-arms from the database on every startup, so a redeploy never
 *     silently stops the schedule.
 *  2. **Remote destinations** (S3 today, FTP behind the same interface) —
 *     see the `destinations/*` server module. Their *connection* config
 *     lives in the allowlisted settings store (secrets masked, audited),
 *     not here; this file carries only the non-secret automation state the
 *     web tier renders and edits.
 *
 * Kept separate from `backups.ts` so the large, stable M10 manifest/restore
 * contract is not re-touched every time the automation surface grows.
 */
import { z } from 'zod';
import { BackupModeSchema } from './backups.js';

// ---------------------------------------------------------------------------
// Schedule frequency. A closed vocabulary, exactly the five choices the spec
// names — never a free-form cron string (the product deliberately offers a
// small fixed menu, not an expression an operator can get subtly wrong).
// `monthly` advances by one *calendar* month, not a fixed 30 days; the other
// non-off frequencies advance by a fixed number of days.
// ---------------------------------------------------------------------------

export const BACKUP_FREQUENCIES = ['off', 'daily', 'every3days', 'weekly', 'monthly'] as const;
export type BackupFrequency = (typeof BACKUP_FREQUENCIES)[number];
export const BackupFrequencySchema = z.enum(BACKUP_FREQUENCIES);

export const BACKUP_FREQUENCY_LABELS: Readonly<Record<BackupFrequency, string>> = {
  off: 'Off',
  daily: 'Every day',
  every3days: 'Every 3 days',
  weekly: 'Every 7 days',
  monthly: 'Every month',
};

/**
 * Fixed interval, in days, for the frequencies that advance by a constant
 * amount. `off` has no interval and `monthly` is a calendar step (handled by
 * `computeNextRun`), so both are `null` — the map is total over the enum so a
 * new frequency can't be added without deciding its interval here.
 */
export const BACKUP_FREQUENCY_INTERVAL_DAYS: Readonly<Record<BackupFrequency, number | null>> = {
  off: null,
  daily: 1,
  every3days: 3,
  weekly: 7,
  monthly: null,
};

// ---------------------------------------------------------------------------
// Retention policy defaults (all user-configurable in Settings). The remote
// keeps the newest N; `null` max-age means "no age cap, count only".
// ---------------------------------------------------------------------------

/** Default number of newest backups kept on a destination — the spec's "keep the 3 newest". */
export const DEFAULT_BACKUP_RETENTION_KEEP = 3;
export const MAX_BACKUP_RETENTION_KEEP = 365;
export const MAX_BACKUP_RETENTION_MAX_AGE_DAYS = 3650;

// ---------------------------------------------------------------------------
// The schedule as the web tier sees it (server -> web). `enabled`,
// `nextRunAt` and `lastRunAt` are *derived* server-side and read-only here —
// the client edits only the policy fields via `BackupScheduleUpdateSchema`.
// ---------------------------------------------------------------------------

export const BackupScheduleSchema = z.object({
  frequency: BackupFrequencySchema,
  /** `true` iff `frequency !== 'off'`. Derived, never stored on its own. */
  enabled: z.boolean(),
  /** Warm (default, live data) or cold (container stopped) — same choice as a manual backup. */
  mode: BackupModeSchema,
  /**
   * Newest N to keep. Prunes uploaded backups on the remote
   * (`BackupUploader#applyRemoteRetention`) and, once a remote is
   * configured, deletes VPS-only backups — never uploaded, or whose upload
   * failed — past the same count (`BackupUploader#applyLocalRetention`). An
   * uploaded backup's local archive is reclaimed regardless of this count,
   * once its remote copy verifies. See FEATURE_MATRIX.md §27c.
   */
  retentionKeep: z.number().int().min(1),
  /** Optional age cap in days, applied like `retentionKeep`; `null` means count-only, no age pruning. */
  retentionMaxAgeDays: z.number().int().min(1).nullable(),
  /** Whether each new backup, scheduled or manual, is uploaded to the configured remote once it verifies — and whether the background sweep retries uploads. */
  uploadToRemote: z.boolean(),
  /** ISO timestamp of the last scheduled run the server fired, or `null` if none yet. */
  lastRunAt: z.string().nullable(),
  /** ISO timestamp of the next run the server will fire, or `null` when off. Derived. */
  nextRunAt: z.string().nullable(),
  /** ISO timestamp the policy was last changed — the anchor the next run is measured from. */
  updatedAt: z.string(),
});
export type BackupSchedule = z.infer<typeof BackupScheduleSchema>;

export const BackupScheduleResponseSchema = z.object({ schedule: BackupScheduleSchema });
export type BackupScheduleResponse = z.infer<typeof BackupScheduleResponseSchema>;

/**
 * The editable policy (web -> server). Only these five fields are writable;
 * everything derived (`enabled`, `nextRunAt`, `lastRunAt`, `updatedAt`) is the
 * server's to compute. No defaults — the form always submits a complete
 * policy, matching this project's "no implicit values" discipline.
 */
export const BackupScheduleUpdateSchema = z.object({
  frequency: BackupFrequencySchema,
  mode: BackupModeSchema,
  retentionKeep: z.number().int().min(1).max(MAX_BACKUP_RETENTION_KEEP),
  retentionMaxAgeDays: z.number().int().min(1).max(MAX_BACKUP_RETENTION_MAX_AGE_DAYS).nullable(),
  uploadToRemote: z.boolean(),
});
export type BackupScheduleUpdate = z.infer<typeof BackupScheduleUpdateSchema>;

// ---------------------------------------------------------------------------
// Remote destination configuration (M13). Configured in Settings. The secret
// (S3 secret access key; FTP password later) is masked on read, revealed only
// through an explicit audited endpoint, and never leaves the server in a
// response body, log or bundle. `s3` in the status is the *non-secret* view —
// the access key id (an identifier, not the secret) is shown, and only a
// boolean says whether a secret is stored.
// ---------------------------------------------------------------------------

export const BACKUP_DESTINATION_TYPES = ['none', 's3', 'ftp'] as const;
export type BackupDestinationType = (typeof BACKUP_DESTINATION_TYPES)[number];
export const BackupDestinationTypeSchema = z.enum(BACKUP_DESTINATION_TYPES);

/** Prefix/key characters we allow through to a remote — a conservative set so a stored prefix can never smuggle exotic path characters into an object key. */
const SAFE_PREFIX = /^[A-Za-z0-9._/-]*$/;

export const BackupDestinationS3StatusSchema = z.object({
  endpoint: z.string(),
  region: z.string(),
  bucket: z.string(),
  prefix: z.string(),
  /** The access key id — an identifier, deliberately shown. Never the secret. */
  accessKeyId: z.string(),
  /** Whether a secret access key is stored. The value itself is never in this response. */
  secretAccessKeySet: z.boolean(),
});
export type BackupDestinationS3Status = z.infer<typeof BackupDestinationS3StatusSchema>;

export const BackupDestinationFtpStatusSchema = z.object({
  host: z.string(),
  port: z.number().int(),
  path: z.string(),
  /** The FTP username — an identifier, deliberately shown. Never the password. */
  user: z.string(),
  /** FTPS (explicit TLS) enabled. */
  secure: z.boolean(),
  /** Whether a password is stored. The value itself is never in this response. */
  passwordSet: z.boolean(),
});
export type BackupDestinationFtpStatus = z.infer<typeof BackupDestinationFtpStatusSchema>;

export const BackupDestinationStatusSchema = z.object({
  type: BackupDestinationTypeSchema,
  configured: z.boolean(),
  /** Credential-free description, e.g. `s3://bucket/prefix` or `ftp://host/path`, or `null` when unconfigured. */
  describe: z.string().nullable(),
  s3: BackupDestinationS3StatusSchema.nullable(),
  ftp: BackupDestinationFtpStatusSchema.nullable(),
});
export type BackupDestinationStatus = z.infer<typeof BackupDestinationStatusSchema>;

export const BackupDestinationStatusResponseSchema = z.object({
  destination: BackupDestinationStatusSchema,
});
export type BackupDestinationStatusResponse = z.infer<typeof BackupDestinationStatusResponseSchema>;

/** Region signed into requests when the admin leaves Region blank. Most S3-compatible providers ignore the value; AWS itself needs the bucket's real region. */
export const DEFAULT_S3_REGION = 'us-east-1';

/** A leading `scheme://` — anything else (`host`, `host:9000`) is a bare host that gets `https://`. */
const HAS_URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/**
 * Normalises what an admin types as the endpoint: `https://` is assumed when no
 * scheme is given (providers show the bare host, e.g. `c123456.provider.net`),
 * and trailing slashes are dropped because the S3 client appends `/<bucket>`.
 */
export function normalizeS3Endpoint(input: string): string {
  const trimmed = input.trim();
  const withScheme = HAS_URL_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

/**
 * Why a normalised endpoint is unusable, or `null` when it is fine. The S3
 * client appends `/<bucket>/<key>` to the endpoint, so a query or fragment
 * would swallow the bucket; userinfo is refused because credentials belong in
 * their own (masked) fields, and anything in the URL is echoed into error
 * messages and logs.
 */
function s3EndpointProblem(value: string): string | null {
  // `http:/host`, `http//host` or `https:host` has no `://`, so normalising
  // made it `https://http:/host` — a host literally named "http".
  if (/^https?:\/\/https?(:|\/)/i.test(value)) {
    return 'The endpoint scheme looks mistyped — write https://s3.example.com, or just the host.';
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'Endpoint must be a host name or an http(s):// URL, e.g. https://s3.example.com.';
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.hostname === '') {
    return 'Endpoint must be a host name or an http(s):// URL, e.g. https://s3.example.com.';
  }
  if (url.username !== '' || url.password !== '' || /^[^:]+:\/\/[^/?#]*@/.test(value)) {
    return 'Endpoint cannot contain a user name or password — put the access key ID and secret in their own fields.';
  }
  if (value.includes('?') || value.includes('#')) {
    return 'Endpoint cannot contain a query string (?…) or fragment (#…) — use just the host, e.g. https://s3.example.com.';
  }
  return null;
}

/**
 * S3 bucket charset. Case is deliberately not enforced — some providers allow
 * mixed-case names, and whether the name is right is the connection test's
 * job — but the name is a URL path segment, so `? # % /`, spaces and a
 * dot-only name (`.`/`..`, which URL parsing collapses) are refused.
 */
const S3_BUCKET_NAME = /^[A-Za-z0-9._-]*$/;

/**
 * The region is signed into the SigV4 credential scope (`<date>/<region>/s3/…`),
 * where a space or slash corrupts the Authorization header — so a provider's
 * display name ("Tehran 3") is refused with a pointer to the region *code*.
 */
const S3_REGION_CODE = /^[A-Za-z0-9._-]*$/;

/**
 * Update the destination config. For S3, `secretAccessKey` is optional: omit it
 * to keep the stored secret unchanged (the form never round-trips the real
 * secret back down to be re-submitted), or provide a new one to replace it.
 *
 * Every string is trimmed (values are usually pasted from a provider
 * dashboard), and the S3 endpoint and region are normalised — so the *output*
 * of this schema, not the raw input, is what the web client sends and the
 * server stores. Messages name the field and the fix, because the form shows
 * them inline under the offending input.
 */
export const BackupDestinationUpdateSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({
    type: z.literal('s3'),
    endpoint: z
      .string()
      .trim()
      .min(1, 'Enter the endpoint, e.g. s3.example.com.')
      .transform(normalizeS3Endpoint)
      .superRefine((endpoint, ctx) => {
        const problem = s3EndpointProblem(endpoint);
        if (problem !== null) ctx.addIssue({ code: 'custom', message: problem });
      }),
    region: z
      .string()
      .trim()
      .regex(
        S3_REGION_CODE,
        "Use the provider's region code (e.g. us-east-1) — letters, digits, . _ and - only, no spaces. Leave it blank if the provider has none.",
      )
      .transform((region) => (region === '' ? DEFAULT_S3_REGION : region))
      .default(DEFAULT_S3_REGION),
    bucket: z
      .string()
      .trim()
      .min(1, 'Enter the bucket name.')
      .regex(
        S3_BUCKET_NAME,
        'Bucket name may contain only letters, digits, . _ and - (no spaces or slashes).',
      )
      .refine((bucket) => !/^\.+$/.test(bucket), 'Bucket name cannot be only dots.'),
    prefix: z
      .string()
      .trim()
      .regex(SAFE_PREFIX, 'Prefix may contain only letters, digits, . _ - and /.'),
    accessKeyId: z
      .string()
      .trim()
      .min(1, 'Enter the access key ID.')
      .regex(/^[^\s/]*$/, 'Access key ID cannot contain spaces or slashes.'),
    // Trimmed like the rest: S3 secret keys never contain whitespace, so edge
    // whitespace is always a paste artefact.
    secretAccessKey: z.string().trim().min(1, 'Secret access key cannot be blank.').optional(),
  }),
  z.object({
    type: z.literal('ftp'),
    host: z.string().trim().min(1, 'Enter the FTP host.'),
    port: z.number().int().min(1).max(65535),
    path: z
      .string()
      .trim()
      .regex(SAFE_PREFIX, 'Path may contain only letters, digits, . _ - and /.'),
    user: z.string().trim().min(1, 'Enter the username.'),
    /** FTPS (explicit TLS). Off is plaintext FTP — allowed, but the UI should warn. */
    secure: z.boolean(),
    /**
     * Optional: omit to keep the stored password unchanged (never round-tripped
     * to the client). Not trimmed — unlike an S3 secret, an FTP password is
     * admin-chosen and may legitimately start or end with a space.
     */
    password: z.string().min(1).optional(),
  }),
]);
/** The normalised update — what the server receives after parsing. */
export type BackupDestinationUpdate = z.infer<typeof BackupDestinationUpdateSchema>;
/** What a client may submit before normalisation (e.g. a bare-host endpoint, a blank region). */
export type BackupDestinationUpdateInput = z.input<typeof BackupDestinationUpdateSchema>;

/** `POST /destination/reveal-secret` — the unmasked secret, plus the audit event this call writes. `null` when none is stored. */
export const BackupDestinationSecretResponseSchema = z.object({
  value: z.string().nullable(),
});
export type BackupDestinationSecretResponse = z.infer<typeof BackupDestinationSecretResponseSchema>;

// ---------------------------------------------------------------------------
// Remote browse + restore-from-remote import. The browse list is the set of
// backups the server sees under its own prefix; `import` selects one by its
// backup id (a symbolic selector, charset-restricted), which the server
// re-derives into a key and confirms against its own listing before pulling.
// ---------------------------------------------------------------------------

export const RemoteBackupItemSchema = z.object({
  backupId: z.string(),
  /** The remote object key, for display only — the client selects by `backupId`, never by supplying this back. */
  key: z.string(),
  sizeBytes: z.number().nonnegative(),
  lastModified: z.string(),
  /** Whether this backup already exists on the local (VPS) disk. */
  alreadyLocal: z.boolean(),
});
export type RemoteBackupItem = z.infer<typeof RemoteBackupItemSchema>;

export const RemoteBackupListResponseSchema = z.object({
  backups: z.array(RemoteBackupItemSchema),
});
export type RemoteBackupListResponse = z.infer<typeof RemoteBackupListResponseSchema>;

/** `POST /remote/import` — pull one remote backup down and verify it. `backupId` charset is restricted so it can never become a traversal path server-side. */
export const BackupImportRequestSchema = z.object({
  backupId: z.string().regex(/^[A-Za-z0-9._-]+$/, 'Invalid backup id.'),
});
export type BackupImportRequest = z.infer<typeof BackupImportRequestSchema>;
