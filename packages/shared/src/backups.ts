/**
 * Backups and restore (M10 — IMPLEMENTATION_PLAN.md §2.1; FEATURE_MATRIX.md
 * §27, which calls it "the highest-risk feature"). This file is
 * the self-describing contract: the four DMS data volumes, the manifest
 * format written *inside* every backup archive, and the API request/
 * response shapes `modules/backups/*` and `apps/web/src/maintenance/*`
 * share.
 *
 * **The manifest is the hard requirement, not a convenience.** DMS ships
 * no official backup tool; this format is ours, so it must be restorable
 * by hand with plain `tar` if the panel itself is unavailable — see
 * `BackupManifestSchema`'s doc comment for the on-disk layout this
 * describes.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// The four volumes (IMPLEMENTATION_PLAN.md §2.1, confirmed from the official
// DMS compose file). Symbolic keys, never the absolute container path,
// travel in any client-facing schema below — mirroring `broker.ts`'s
// `LogFileSourceSchema` pattern exactly. The authoritative key -> absolute
// path mapping is broker-owned (`apps/broker/src/archive-routes.ts`); the
// copy here is display/manifest metadata only, asserted equal to the
// broker's own map by `backups.test.ts`.
// ---------------------------------------------------------------------------

export const BACKUP_VOLUME_KEYS = ['mail', 'mailState', 'mailLog', 'dmsConfig'] as const;
export type BackupVolumeKey = (typeof BACKUP_VOLUME_KEYS)[number];
export const BackupVolumeKeySchema = z.enum(BACKUP_VOLUME_KEYS);

/** Display/manifest-only copy of the real container paths — see the module header. Never used to build a request; nothing in this file accepts a client-supplied path. */
export const BACKUP_VOLUME_CONTAINER_PATHS: Readonly<Record<BackupVolumeKey, string>> = {
  mail: '/var/mail',
  mailState: '/var/mail-state',
  mailLog: '/var/log/mail',
  dmsConfig: '/tmp/docker-mailserver',
};

export const BACKUP_VOLUME_LABELS: Readonly<Record<BackupVolumeKey, string>> = {
  mail: 'Mail data',
  mailState: 'Mail state (Dovecot indexes, Fail2ban)',
  mailLog: 'Mail logs',
  dmsConfig: 'Configuration (.cf files, DKIM keys, TLS certificates)',
};

// ---------------------------------------------------------------------------
// Backup mode (IMPLEMENTATION_PLAN.md §2.1 "Consistency"). Mail data is
// live during a `warm` backup — the default, with the caveat stated in the
// UI. `cold` stops the managed container first, producing a consistent
// archive at the cost of downtime; the admin chooses explicitly, there is
// no implicit escalation from one to the other.
// ---------------------------------------------------------------------------

export const BACKUP_MODES = ['warm', 'cold'] as const;
export type BackupMode = (typeof BACKUP_MODES)[number];
export const BackupModeSchema = z.enum(BACKUP_MODES);

export const BACKUP_VERIFICATION_STATUSES = ['unverified', 'verified', 'failed'] as const;
export type BackupVerificationStatus = (typeof BACKUP_VERIFICATION_STATUSES)[number];
export const BackupVerificationStatusSchema = z.enum(BACKUP_VERIFICATION_STATUSES);

// ---------------------------------------------------------------------------
// Remote-upload state (M13). A backup's local archive is a *staging* copy;
// once it is uploaded to a configured remote AND the remote copy is checksum-
// verified, the local copy is reclaimed. This four-state machine is tracked
// per backup so the Backups page can show where each one lives and offer
// "Upload"/"Retry upload":
//   pending   — not yet uploaded (no remote configured, or awaiting upload)
//   uploading — an upload attempt is in progress
//   uploaded  — present AND checksum-verified on the remote
//   failed    — an attempt failed; the local copy is kept for re-upload
// ---------------------------------------------------------------------------

export const BACKUP_UPLOAD_STATUSES = ['pending', 'uploading', 'uploaded', 'failed'] as const;
export type BackupUploadStatus = (typeof BACKUP_UPLOAD_STATUSES)[number];
export const BackupUploadStatusSchema = z.enum(BACKUP_UPLOAD_STATUSES);

export const BACKUP_UPLOAD_STATUS_LABELS: Readonly<Record<BackupUploadStatus, string>> = {
  pending: 'Not uploaded',
  uploading: 'Uploading',
  uploaded: 'Uploaded',
  failed: 'Upload failed',
};

// ---------------------------------------------------------------------------
// Manifest — written as `manifest.json` inside every backup archive
// (uncompressed `tar`, so `tar -xf backup.tar manifest.json` reads it with
// no panel involved at all) and duplicated into the `backups.manifest`
// column so list/detail views never have to open the archive.
//
// **On-disk layout of the outer archive** (documented here because this
// schema *is* the promise of what an operator finds):
//   manifest.json   — this schema, serialised
//   mail.tar        — raw bytes of `docker archive get` on /var/mail,
//                      untouched — every entry's uid/gid/mode/mtime is
//                      exactly what the container had, because this
//                      project never re-serialises it (see
//                      `modules/backups/archive-transfer.ts`)
//   mailState.tar    — same, for /var/mail-state
//   mailLog.tar       — same, for /var/log/mail
//   dmsConfig.tar     — same, for /tmp/docker-mailserver
//
// An operator with no working panel restores by hand with:
//   tar -xf backup.tar mail.tar && tar -xf mail.tar -C <target>
// (repeated per volume) — plain `tar`, twice, no other tool. This is
// exactly what `notes` in the manifest itself says, so the instructions
// travel with the archive.
// ---------------------------------------------------------------------------

export const BACKUP_MANIFEST_SCHEMA_VERSION = 1;

export const BackupManifestEntrySchema = z.object({
  volumeKey: BackupVolumeKeySchema,
  /** Path exactly as it appears inside that volume's own `<key>.tar` — whatever Docker's archive-get produced, never rewritten. */
  path: z.string(),
  sizeBytes: z.number().nonnegative(),
  checksumSha256: z.string().length(64),
});
export type BackupManifestEntry = z.infer<typeof BackupManifestEntrySchema>;

export const BackupManifestVolumeSchema = z.object({
  key: BackupVolumeKeySchema,
  containerPath: z.string(),
  entryCount: z.number().nonnegative(),
  sizeBytes: z.number().nonnegative(),
  /** SHA-256 of the whole `<key>.tar` blob — lets `verify` check one volume without re-walking every entry, and lets a by-hand operator confirm a single extracted `.tar` is intact with `sha256sum`. */
  checksumSha256: z.string().length(64),
});
export type BackupManifestVolume = z.infer<typeof BackupManifestVolumeSchema>;

export const BackupManifestSchema = z.object({
  schemaVersion: z.literal(BACKUP_MANIFEST_SCHEMA_VERSION),
  panelVersion: z.string(),
  /**
   * The managed container's resolved image digest at backup time
   * (`ContainerInspectResponse.image` — Docker's own content-addressed
   * image id), or `null` if it could not be resolved. This is what
   * restore's manifest-compatibility check compares against the
   * *currently running* image before ever touching data
   * (IMPLEMENTATION_PLAN.md §2.1 "refuse-with-explanation on mismatch").
   */
  dmsImageDigest: z.string().nullable(),
  createdAt: z.string(),
  createdBy: z.object({ adminId: z.string().nullable(), label: z.string() }),
  mode: BackupModeSchema,
  volumes: z.array(BackupManifestVolumeSchema),
  entries: z.array(BackupManifestEntrySchema),
  /** Human-readable, self-contained restore-by-hand instructions — see the module header's on-disk layout. Generated once at backup time so it travels with the archive even if this schema's own doc comment is never read. */
  notes: z.string(),
});
export type BackupManifest = z.infer<typeof BackupManifestSchema>;

// ---------------------------------------------------------------------------
// API — list/detail/create/verify/delete/download. Backups are addressed
// by opaque id everywhere (SECURITY.md §3.10: "Backups are addressed by
// opaque ID and resolved server-side") — no schema below accepts a
// filesystem path.
// ---------------------------------------------------------------------------

export const BackupVolumeSummarySchema = z.object({
  key: BackupVolumeKeySchema,
  entryCount: z.number().nonnegative(),
  sizeBytes: z.number().nonnegative(),
});
export type BackupVolumeSummary = z.infer<typeof BackupVolumeSummarySchema>;

export const BackupSummarySchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  createdByAdminId: z.string().nullable(),
  createdByLabel: z.string(),
  mode: BackupModeSchema,
  sizeBytes: z.number().nonnegative(),
  dmsImageDigest: z.string().nullable(),
  volumes: z.array(BackupVolumeSummarySchema),
  verificationStatus: BackupVerificationStatusSchema,
  verifiedAt: z.string().nullable(),
  /** Remote-upload state (M13). `pending` when no remote is configured or the backup is simply not yet uploaded. */
  uploadStatus: BackupUploadStatusSchema,
  /** Credential-free description of the destination the backup was uploaded to (e.g. `s3://bucket/prefix`), or `null`. Never a URL or key. */
  uploadDestination: z.string().nullable(),
  /** ISO timestamp the remote copy was verified present, or `null`. Distinct from `verifiedAt` (which is the local archive's own integrity check). */
  uploadedAt: z.string().nullable(),
  /** Safe, non-secret summary of the last upload failure for a `failed` backup, or `null`. Never a signed URL or credential. */
  uploadError: z.string().nullable(),
  /** Whether the archive still exists on local (VPS) disk. `false` once a verified remote copy let staging reclaim the space — the backup then lives only on the remote. */
  localPresent: z.boolean(),
});
export type BackupSummary = z.infer<typeof BackupSummarySchema>;

export const BackupListResponseSchema = z.object({ backups: z.array(BackupSummarySchema) });
export type BackupListResponse = z.infer<typeof BackupListResponseSchema>;

export const BackupDetailResponseSchema = z.object({
  backup: BackupSummarySchema,
  manifest: BackupManifestSchema,
});
export type BackupDetailResponse = z.infer<typeof BackupDetailResponseSchema>;

export const CreateBackupRequestSchema = z.object({ mode: BackupModeSchema });
export type CreateBackupRequest = z.infer<typeof CreateBackupRequestSchema>;

/** `POST /:id/verify` and `POST /` both enqueue a job — this is that job's ack, not the finished result (poll/stream the job for that). */
export const BackupJobAckSchema = z.object({ jobId: z.string() });
export type BackupJobAck = z.infer<typeof BackupJobAckSchema>;

// ---------------------------------------------------------------------------
// Restore — Tier 4 (UX_ARCHITECTURE.md §8). Pre-flight is a pure read; the
// restore request itself carries the two hard, server-checked gates
// FEATURE_MATRIX.md §27 requires ("either a verified recent backup or
// explicit acknowledgement"): an explicit `confirm: true` (never defaulted,
// mirroring `DeleteMailboxRequestSchema`'s `mailData` — FEATURE_MATRIX.md
// §3's "always pass an explicit flag" rule) and, only when no recent
// verified backup already exists, an explicit acknowledgement. Container-
// stopped and manifest-digest compatibility are *not* acknowledgeable —
// preflight reports them, but the restore route refuses outright rather
// than accepting an override, per IMPLEMENTATION_PLAN.md §2.1's
// "refuse-with-explanation on mismatch rather than proceeding hopefully".
// ---------------------------------------------------------------------------

export const RestorePreflightResponseSchema = z.object({
  backup: BackupSummarySchema,
  containerRunning: z.boolean(),
  currentDmsImageDigest: z.string().nullable(),
  manifestCompatible: z.boolean(),
  /** Always present when `manifestCompatible` is false; explains exactly why (IMPLEMENTATION_PLAN.md §2.1). */
  compatibilityMessage: z.string().nullable(),
  /** Whether a *different*, verified backup newer than this restore's target exists — the Tier 4 backup gate (UX_ARCHITECTURE.md §8), evaluated for the admin's *current* data, not for the archive about to overwrite it. */
  recentVerifiedBackupExists: z.boolean(),
  mostRecentVerifiedBackupAt: z.string().nullable(),
  /** Static, always-present reminder of the vmail UID/GID gotcha (IMPLEMENTATION_PLAN.md §2.1) — surfaced in the pre-flight report itself, not left to documentation an admin may never open. */
  vmailOwnershipNote: z.string(),
});
export type RestorePreflightResponse = z.infer<typeof RestorePreflightResponseSchema>;

export const RestoreBackupRequestSchema = z.object({
  /** Must be the literal `true` — a truthy-but-not-`true` value (e.g. `1`, `"true"`) fails validation, matching this project's existing "no implicit confirmation" discipline. */
  confirm: z.literal(true),
  /** Required whenever `RestorePreflightResponse.recentVerifiedBackupExists` is `false`; ignored (but still validated as a boolean) otherwise. No default — see the module header. */
  acknowledgeNoRecentBackup: z.boolean(),
});
export type RestoreBackupRequest = z.infer<typeof RestoreBackupRequestSchema>;

// ---------------------------------------------------------------------------
// Updates (IMPLEMENTATION_PLAN.md §2.2) — status/comparison only. There is
// no apply-request schema here: applying an update needs container
// recreation, which the broker deliberately lacks, so
// `modules/updates/updates.routes.ts` refuses before any request body
// would matter. See that module for the exact refusal.
// ---------------------------------------------------------------------------

export const UpdateStatusResponseSchema = z.object({
  current: z.object({
    digest: z.string().nullable(),
    repoTags: z.array(z.string()),
  }),
  available: z
    .object({
      digest: z.string(),
      checkedAt: z.string(),
    })
    .nullable(),
  updateAvailable: z.boolean(),
  /** `null` only when neither digest could be resolved at all — an unreachable registry still yields a response, with `available: null`, never a thrown error (the same "Unknown, not Invalid" discipline as DNS state, AGENT_BRIEF.md §4). */
  checkedAt: z.string(),
  releaseNotesUrl: z.string(),
  /** Backup-gate info, reusing the exact same shape restore's pre-flight does — one recent-verified-backup concept for the whole product, not two. */
  recentVerifiedBackupExists: z.boolean(),
  mostRecentVerifiedBackupAt: z.string().nullable(),
  /**
   * Always present, regardless of whether an update is even available —
   * the honesty requirement is unconditional (IMPLEMENTATION_PLAN.md §2.2:
   * "Promising a clean rollback would be the most dangerous lie the
   * product could tell"), not something that only appears once an admin
   * is about to click something.
   */
  rollbackCaveat: z.string(),
});
export type UpdateStatusResponse = z.infer<typeof UpdateStatusResponseSchema>;
