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
  /** Newest N to keep (local staging and remote both honour it). */
  retentionKeep: z.number().int().min(1),
  /** Optional age cap in days; `null` means count-only, no age pruning. */
  retentionMaxAgeDays: z.number().int().min(1).nullable(),
  /** Whether a scheduled backup is uploaded to the configured remote after it is archived. */
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

export const BACKUP_DESTINATION_TYPES = ['none', 's3'] as const; // 'ftp' lands with the FTP chunk
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

export const BackupDestinationStatusSchema = z.object({
  type: BackupDestinationTypeSchema,
  configured: z.boolean(),
  /** Credential-free description, e.g. `s3://bucket/prefix`, or `null` when unconfigured. */
  describe: z.string().nullable(),
  s3: BackupDestinationS3StatusSchema.nullable(),
});
export type BackupDestinationStatus = z.infer<typeof BackupDestinationStatusSchema>;

export const BackupDestinationStatusResponseSchema = z.object({
  destination: BackupDestinationStatusSchema,
});
export type BackupDestinationStatusResponse = z.infer<typeof BackupDestinationStatusResponseSchema>;

/**
 * Update the destination config. For S3, `secretAccessKey` is optional: omit it
 * to keep the stored secret unchanged (the form never round-trips the real
 * secret back down to be re-submitted), or provide a new one to replace it.
 */
export const BackupDestinationUpdateSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({
    type: z.literal('s3'),
    endpoint: z.string().url(),
    region: z.string().min(1),
    bucket: z.string().min(1),
    prefix: z.string().regex(SAFE_PREFIX, 'Prefix may contain only letters, digits, . _ - and /.'),
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1).optional(),
  }),
]);
export type BackupDestinationUpdate = z.infer<typeof BackupDestinationUpdateSchema>;

/** `POST /destination/reveal-secret` — the unmasked secret, plus the audit event this call writes. `null` when none is stored. */
export const BackupDestinationSecretResponseSchema = z.object({
  value: z.string().nullable(),
});
export type BackupDestinationSecretResponse = z.infer<typeof BackupDestinationSecretResponseSchema>;
