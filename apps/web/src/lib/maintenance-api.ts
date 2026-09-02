/**
 * Typed wrappers over `/api/v1/jobs/*`, `/api/v1/backups/*`,
 * `/api/v1/updates/*` and `/api/v1/config/*` (M10 —
 * `apps/server/src/modules/{jobs,backups,updates,config}/*.routes.ts`).
 * Mirrors `docker-api.ts`'s shape.
 *
 * Two routes deliberately do not go through `request` the way the rest do:
 * the backup download is a `tar` body (see `backupDownloadUrl`), and the
 * job stream is SSE (`maintenance/use-maintenance-queries.ts`'s
 * `useJobStream`) — neither is JSON, so neither can be parsed by a Zod
 * response schema.
 */
import {
  ApplyConfigRequestSchema,
  ApplyConfigResponseSchema,
  BackupDestinationSecretResponseSchema,
  BackupDestinationStatusResponseSchema,
  BackupDestinationUpdateSchema,
  BackupDetailResponseSchema,
  BackupImportRequestSchema,
  BackupJobAckSchema,
  BackupListResponseSchema,
  BackupScheduleResponseSchema,
  BackupScheduleUpdateSchema,
  ConfigSettingsResponseSchema,
  ConfigSnapshotListResponseSchema,
  CreateBackupRequestSchema,
  JobDetailResponseSchema,
  JobListResponseSchema,
  OperationAckSchema,
  RemoteBackupListResponseSchema,
  RestoreBackupRequestSchema,
  RestorePreflightResponseSchema,
  RevealSettingResponseSchema,
  RollbackConfigRequestSchema,
  UpdateStatusResponseSchema,
  ValidateConfigRequestSchema,
  ValidateConfigResponseSchema,
  type ApplyConfigResponse,
  type BackupDestinationSecretResponse,
  type BackupDestinationStatus,
  type BackupDestinationUpdate,
  type BackupDetailResponse,
  type BackupMode,
  type BackupSchedule,
  type BackupScheduleUpdate,
  type BackupSummary,
  type ConfigChangeSet,
  type ConfigSetting,
  type ConfigSnapshotSummary,
  type Job,
  type JobDetailResponse,
  type RemoteBackupItem,
  type RestoreBackupRequest,
  type RestorePreflightResponse,
  type RevealSettingResponse,
  type UpdateStatusResponse,
  type ValidateConfigResponse,
} from '@dwg/shared';
import { request } from './api-client';

// ---------------------------------------------------------------------------
// Jobs (ARCHITECTURE.md §7.5) — the runner owns every status transition, so
// everything here is read-only except `cancelJob`.
// ---------------------------------------------------------------------------

export async function fetchJobs(): Promise<readonly Job[]> {
  const { jobs } = await request('/api/v1/jobs', JobListResponseSchema, { method: 'GET' });
  return jobs;
}

export async function fetchJob(jobId: string): Promise<JobDetailResponse> {
  return request(`/api/v1/jobs/${encodeURIComponent(jobId)}`, JobDetailResponseSchema, {
    method: 'GET',
  });
}

export async function cancelJob(jobId: string): Promise<JobDetailResponse> {
  return request(`/api/v1/jobs/${encodeURIComponent(jobId)}/cancel`, JobDetailResponseSchema, {
    method: 'POST',
  });
}

/**
 * URL of the SSE endpoint for one job. Returned as a string rather than
 * opened here because `EventSource` is lifecycle state, not a one-shot
 * fetch — `useJobStream` owns opening and closing it.
 */
export function jobStreamUrl(jobId: string): string {
  return `/api/v1/jobs/${encodeURIComponent(jobId)}/stream`;
}

// ---------------------------------------------------------------------------
// Backups (FEATURE_MATRIX.md §27). Create/verify/restore all answer with a
// job id, not a result — the work outlives the request, so the caller
// follows the job (`fetchJob`/`jobStreamUrl`) from there.
// ---------------------------------------------------------------------------

export async function fetchBackups(): Promise<readonly BackupSummary[]> {
  const { backups } = await request('/api/v1/backups', BackupListResponseSchema, { method: 'GET' });
  return backups;
}

export async function fetchBackup(backupId: string): Promise<BackupDetailResponse> {
  return request(`/api/v1/backups/${encodeURIComponent(backupId)}`, BackupDetailResponseSchema, {
    method: 'GET',
  });
}

export async function createBackup(mode: BackupMode): Promise<string> {
  const body = CreateBackupRequestSchema.parse({ mode });
  const { jobId } = await request('/api/v1/backups', BackupJobAckSchema, {
    method: 'POST',
    body,
  });
  return jobId;
}

export async function verifyBackup(backupId: string): Promise<string> {
  const { jobId } = await request(
    `/api/v1/backups/${encodeURIComponent(backupId)}/verify`,
    BackupJobAckSchema,
    { method: 'POST' },
  );
  return jobId;
}

export async function deleteBackup(backupId: string): Promise<void> {
  await request(`/api/v1/backups/${encodeURIComponent(backupId)}`, OperationAckSchema, {
    method: 'DELETE',
  });
}

/**
 * Href for an anchor, not something to `fetch`. The response is a raw
 * `application/x-tar` body with a `content-disposition` filename the
 * server chooses; going through `request` would buffer the whole archive
 * in memory and then fail Zod parsing, and re-implementing the download in
 * JS would throw away the browser's own progress/resume handling.
 */
export function backupDownloadUrl(backupId: string): string {
  return `/api/v1/backups/${encodeURIComponent(backupId)}/download`;
}

export async function fetchRestorePreflight(backupId: string): Promise<RestorePreflightResponse> {
  return request(
    `/api/v1/backups/${encodeURIComponent(backupId)}/restore/preflight`,
    RestorePreflightResponseSchema,
    { method: 'GET' },
  );
}

export async function restoreBackup(
  backupId: string,
  input: RestoreBackupRequest,
): Promise<string> {
  const body = RestoreBackupRequestSchema.parse(input);
  const { jobId } = await request(
    `/api/v1/backups/${encodeURIComponent(backupId)}/restore`,
    BackupJobAckSchema,
    { method: 'POST', body },
  );
  return jobId;
}

// ---------------------------------------------------------------------------
// Backup automation (M13) — scheduled backups + remote destinations. The
// schedule and destination config are normal reads/writes; upload/import/
// reconcile answer with a job id, like create/verify/restore. Revealing the
// destination secret is a `POST` because it is an audited write.
// ---------------------------------------------------------------------------

export async function fetchBackupSchedule(): Promise<BackupSchedule> {
  const { schedule } = await request('/api/v1/backups/schedule', BackupScheduleResponseSchema, {
    method: 'GET',
  });
  return schedule;
}

export async function updateBackupSchedule(update: BackupScheduleUpdate): Promise<BackupSchedule> {
  const body = BackupScheduleUpdateSchema.parse(update);
  const { schedule } = await request('/api/v1/backups/schedule', BackupScheduleResponseSchema, {
    method: 'PUT',
    body,
  });
  return schedule;
}

export async function fetchBackupDestination(): Promise<BackupDestinationStatus> {
  const { destination } = await request(
    '/api/v1/backups/destination',
    BackupDestinationStatusResponseSchema,
    { method: 'GET' },
  );
  return destination;
}

export async function updateBackupDestination(
  update: BackupDestinationUpdate,
): Promise<BackupDestinationStatus> {
  const body = BackupDestinationUpdateSchema.parse(update);
  const { destination } = await request(
    '/api/v1/backups/destination',
    BackupDestinationStatusResponseSchema,
    { method: 'PUT', body },
  );
  return destination;
}

export async function testBackupDestination(): Promise<void> {
  await request('/api/v1/backups/destination/test', OperationAckSchema, { method: 'POST' });
}

/** The one path that returns the real secret — an audited `POST`, never cached, only ever run by an explicit reveal action. */
export async function revealBackupDestinationSecret(): Promise<BackupDestinationSecretResponse> {
  return request(
    '/api/v1/backups/destination/reveal-secret',
    BackupDestinationSecretResponseSchema,
    { method: 'POST' },
  );
}

export async function fetchRemoteBackups(): Promise<readonly RemoteBackupItem[]> {
  const { backups } = await request('/api/v1/backups/remote', RemoteBackupListResponseSchema, {
    method: 'GET',
  });
  return backups;
}

export async function uploadBackup(backupId: string): Promise<string> {
  const { jobId } = await request(
    `/api/v1/backups/${encodeURIComponent(backupId)}/upload`,
    BackupJobAckSchema,
    { method: 'POST' },
  );
  return jobId;
}

export async function importRemoteBackup(backupId: string): Promise<string> {
  const body = BackupImportRequestSchema.parse({ backupId });
  const { jobId } = await request('/api/v1/backups/remote/import', BackupJobAckSchema, {
    method: 'POST',
    body,
  });
  return jobId;
}

export async function reconcileRemote(): Promise<string> {
  const { jobId } = await request('/api/v1/backups/reconcile', BackupJobAckSchema, {
    method: 'POST',
  });
  return jobId;
}

// ---------------------------------------------------------------------------
// Updates (IMPLEMENTATION_PLAN.md §2.2) — status is a normal read; apply
// has no success path at all (see `applyUpdate`).
// ---------------------------------------------------------------------------

export async function fetchUpdateStatus(): Promise<UpdateStatusResponse> {
  return request('/api/v1/updates', UpdateStatusResponseSchema, { method: 'GET' });
}

/**
 * Always rejects with an `ApiError` (`CAPABILITY_UNSUPPORTED`): applying an
 * update needs container recreation, which the broker deliberately lacks
 * (`modules/updates/updates.routes.ts`). The call is still made rather than
 * short-circuited client-side so the server's own explanation — and the
 * audit event it writes — is what the admin sees. The response schema is
 * therefore never reached; it is only here because `request` requires one.
 */
export async function applyUpdate(): Promise<void> {
  await request('/api/v1/updates/apply', OperationAckSchema, { method: 'POST' });
}

// ---------------------------------------------------------------------------
// Configuration editor (FEATURE_MATRIX.md §28-29). Fixed pipeline:
// validate -> apply, with snapshots as the rollback path. Revealing a
// secret is a `POST` because it is an audited write, not a read.
// ---------------------------------------------------------------------------

export async function fetchConfigSettings(): Promise<readonly ConfigSetting[]> {
  const { settings } = await request('/api/v1/config/settings', ConfigSettingsResponseSchema, {
    method: 'GET',
  });
  return settings;
}

export async function revealConfigSetting(key: string): Promise<RevealSettingResponse> {
  return request(
    `/api/v1/config/settings/${encodeURIComponent(key)}/reveal`,
    RevealSettingResponseSchema,
    { method: 'POST' },
  );
}

export async function validateConfig(changes: ConfigChangeSet): Promise<ValidateConfigResponse> {
  const body = ValidateConfigRequestSchema.parse({ changes });
  return request('/api/v1/config/validate', ValidateConfigResponseSchema, {
    method: 'POST',
    body,
  });
}

export async function applyConfig(changes: ConfigChangeSet): Promise<ApplyConfigResponse> {
  const body = ApplyConfigRequestSchema.parse({ changes, confirm: true });
  return request('/api/v1/config/apply', ApplyConfigResponseSchema, { method: 'POST', body });
}

export async function fetchConfigSnapshots(): Promise<readonly ConfigSnapshotSummary[]> {
  const { snapshots } = await request(
    '/api/v1/config/snapshots',
    ConfigSnapshotListResponseSchema,
    { method: 'GET' },
  );
  return snapshots;
}

export async function rollbackConfig(snapshotId: string): Promise<ApplyConfigResponse> {
  const body = RollbackConfigRequestSchema.parse({ confirm: true });
  return request(
    `/api/v1/config/snapshots/${encodeURIComponent(snapshotId)}/rollback`,
    ApplyConfigResponseSchema,
    { method: 'POST', body },
  );
}
