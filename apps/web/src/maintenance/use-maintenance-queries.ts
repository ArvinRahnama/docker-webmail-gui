/**
 * TanStack Query hooks over `lib/maintenance-api.ts`, mirroring
 * `docker/use-docker-queries.ts`'s shape — plus one thing that milestone
 * did not need: `useJobStream`, an `EventSource` subscription rather than a
 * query, because job progress is pushed by the server (ARCHITECTURE.md §8)
 * and polling it would both lag the real state and miss log lines.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  JobStreamEventSchema,
  type BackupMode,
  type BackupScheduleUpdate,
  type ConfigChangeSet,
  type Job,
  type JobLogEntry,
  type RestoreBackupRequest,
} from '@dwg/shared';
import {
  applyConfig,
  applyUpdate,
  backupDownloadUrl,
  cancelJob,
  createBackup,
  deleteBackup,
  fetchBackup,
  fetchBackupDestination,
  fetchBackupSchedule,
  fetchBackups,
  fetchConfigSettings,
  fetchConfigSnapshots,
  fetchJob,
  fetchJobs,
  fetchRemoteBackups,
  fetchRestorePreflight,
  fetchUpdateStatus,
  importRemoteBackup,
  jobStreamUrl,
  reconcileRemote,
  restoreBackup,
  revealBackupDestinationSecret,
  revealConfigSetting,
  rollbackConfig,
  testBackupDestination,
  updateBackupDestination,
  updateBackupSchedule,
  uploadBackup,
  validateConfig,
  verifyBackup,
} from '@/lib/maintenance-api';

// ---------------------------------------------------------------------------
// Jobs (ARCHITECTURE.md §7.5)
// ---------------------------------------------------------------------------

export const jobsKey = ['maintenance', 'jobs'] as const;
export const jobKey = (jobId: string) => ['maintenance', 'jobs', jobId] as const;

export function useJobsQuery() {
  return useQuery({ queryKey: jobsKey, queryFn: fetchJobs });
}

export function useJobQuery(jobId: string) {
  return useQuery({
    queryKey: jobKey(jobId),
    queryFn: () => fetchJob(jobId),
    enabled: jobId.length > 0,
  });
}

export function useCancelJobMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => cancelJob(jobId),
    // A cancelled backup/restore job leaves the backup list in a different
    // state than it found it, so that list is invalidated too.
    onSuccess: (_result, jobId) => {
      void queryClient.invalidateQueries({ queryKey: jobsKey });
      void queryClient.invalidateQueries({ queryKey: jobKey(jobId) });
      void queryClient.invalidateQueries({ queryKey: backupsKey });
    },
  });
}

/** What {@link useJobStream} accumulates from the SSE frames of one job. */
export interface JobStreamState {
  /** Latest `snapshot` frame's job. `null` until the first frame arrives — the server sends one immediately on connect, so this is a brief connecting state, not an error. */
  readonly job: Job | null;
  /** Every `log` frame received on this connection, in arrival order. Does *not* include logs written before the stream opened; pair with `useJobQuery` for that history. */
  readonly logs: readonly JobLogEntry[];
  /** `true` once the browser has reported the connection as open, `false` while connecting or after an error. `EventSource` reconnects on its own, so a `false` here is not necessarily terminal. */
  readonly connected: boolean;
}

/**
 * Subscribes to `GET /api/v1/jobs/:id/stream` and holds the latest job
 * snapshot plus this connection's log frames. Pass an empty `jobId` to
 * subscribe to nothing (the same "not yet addressable" idiom the `enabled`
 * flags above use) — there is no other way to conditionally hold a
 * subscription without breaking hook order.
 *
 * Frames are validated with `JobStreamEventSchema` rather than trusted: an
 * unparseable frame is dropped instead of poisoning the state, matching
 * `api-client.ts`'s refusal to hand back an unvalidated body. The stream is
 * cookie-authenticated like every other call; `EventSource` sends
 * same-origin cookies by default, and a GET needs no CSRF token.
 */
export function useJobStream(jobId: string): JobStreamState {
  const [state, setState] = useState<JobStreamState>({ job: null, logs: [], connected: false });

  useEffect(() => {
    if (jobId.length === 0) return;

    // Reset per job id: leaving the previous job's snapshot visible while
    // the new stream connects would briefly show the wrong job's progress.
    setState({ job: null, logs: [], connected: false });

    const source = new EventSource(jobStreamUrl(jobId));

    source.onopen = () => {
      setState((prev) => ({ ...prev, connected: true }));
    };

    source.onerror = () => {
      setState((prev) => ({ ...prev, connected: false }));
    };

    source.onmessage = (event: MessageEvent<string>) => {
      let json: unknown;
      try {
        json = JSON.parse(event.data);
      } catch {
        return;
      }
      const parsed = JobStreamEventSchema.safeParse(json);
      if (!parsed.success) return;

      setState((prev) =>
        parsed.data.kind === 'snapshot'
          ? { ...prev, job: parsed.data.job, connected: true }
          : { ...prev, logs: [...prev.logs, parsed.data.entry], connected: true },
      );
    };

    return () => {
      source.close();
    };
  }, [jobId]);

  return state;
}

// ---------------------------------------------------------------------------
// Backups (FEATURE_MATRIX.md §27). Create/verify/restore resolve to a job
// id, so their `onSuccess` invalidates the job list the caller is about to
// watch as well as the backup list itself.
// ---------------------------------------------------------------------------

export const backupsKey = ['maintenance', 'backups'] as const;
export const backupKey = (backupId: string) => ['maintenance', 'backups', backupId] as const;
export const restorePreflightKey = (backupId: string) =>
  ['maintenance', 'backups', backupId, 'restore', 'preflight'] as const;

export function useBackupsQuery() {
  return useQuery({ queryKey: backupsKey, queryFn: fetchBackups });
}

export function useBackupQuery(backupId: string) {
  return useQuery({
    queryKey: backupKey(backupId),
    queryFn: () => fetchBackup(backupId),
    enabled: backupId.length > 0,
  });
}

export function useCreateBackupMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (mode: BackupMode) => createBackup(mode),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: jobsKey });
      void queryClient.invalidateQueries({ queryKey: backupsKey });
    },
  });
}

export function useVerifyBackupMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (backupId: string) => verifyBackup(backupId),
    onSuccess: (_jobId, backupId) => {
      void queryClient.invalidateQueries({ queryKey: jobsKey });
      void queryClient.invalidateQueries({ queryKey: backupsKey });
      void queryClient.invalidateQueries({ queryKey: backupKey(backupId) });
    },
  });
}

export function useDeleteBackupMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (backupId: string) => deleteBackup(backupId),
    // Deleting a backup can change whether a recent *verified* backup
    // exists, which is the gate both restore pre-flight and the update
    // status report on — hence those two are invalidated as well.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: backupsKey });
      void queryClient.invalidateQueries({ queryKey: updateStatusKey });
    },
  });
}

export function useRestorePreflightQuery(backupId: string) {
  return useQuery({
    queryKey: restorePreflightKey(backupId),
    queryFn: () => fetchRestorePreflight(backupId),
    enabled: backupId.length > 0,
  });
}

export function useRestoreBackupMutation(backupId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: RestoreBackupRequest) => restoreBackup(backupId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: jobsKey });
      void queryClient.invalidateQueries({ queryKey: restorePreflightKey(backupId) });
    },
  });
}

/** Re-exported so a page can build the download anchor's `href` without importing the fetch layer directly, the way every other route here is reached through this module. */
export { backupDownloadUrl };

// ---------------------------------------------------------------------------
// Backup automation (M13) — scheduled backups + remote destinations. Upload/
// import/reconcile answer with a job id, so they invalidate the job list the
// caller is about to watch, plus the backup and remote lists whose state they
// change.
// ---------------------------------------------------------------------------

export const backupScheduleKey = ['maintenance', 'backups', 'schedule'] as const;
export const backupDestinationKey = ['maintenance', 'backups', 'destination'] as const;
export const remoteBackupsKey = ['maintenance', 'backups', 'remote'] as const;

export function useBackupScheduleQuery() {
  return useQuery({ queryKey: backupScheduleKey, queryFn: fetchBackupSchedule });
}

export function useUpdateBackupScheduleMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (update: BackupScheduleUpdate) => updateBackupSchedule(update),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: backupScheduleKey });
    },
  });
}

export function useBackupDestinationQuery() {
  return useQuery({ queryKey: backupDestinationKey, queryFn: fetchBackupDestination });
}

export function useUpdateBackupDestinationMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateBackupDestination,
    // A destination change can turn remote browse on/off and kick a reconcile,
    // so the remote list and backup list are both invalidated.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: backupDestinationKey });
      void queryClient.invalidateQueries({ queryKey: remoteBackupsKey });
      void queryClient.invalidateQueries({ queryKey: backupsKey });
    },
  });
}

/** A mutation despite being a connectivity check — a `POST` action with no cache key, run only on an explicit click. */
export function useTestBackupDestinationMutation() {
  return useMutation({ mutationFn: testBackupDestination });
}

/** A mutation, not a query: revealing the secret is an audited `POST`, so it must be explicit and never re-run by a refetch (mirrors `useRevealConfigSettingMutation`). */
export function useRevealBackupDestinationSecretMutation() {
  return useMutation({ mutationFn: revealBackupDestinationSecret });
}

export function useRemoteBackupsQuery(enabled: boolean) {
  return useQuery({ queryKey: remoteBackupsKey, queryFn: fetchRemoteBackups, enabled });
}

export function useUploadBackupMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (backupId: string) => uploadBackup(backupId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: jobsKey });
      void queryClient.invalidateQueries({ queryKey: backupsKey });
      void queryClient.invalidateQueries({ queryKey: remoteBackupsKey });
    },
  });
}

export function useImportRemoteBackupMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (backupId: string) => importRemoteBackup(backupId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: jobsKey });
      void queryClient.invalidateQueries({ queryKey: backupsKey });
    },
  });
}

export function useReconcileRemoteMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: reconcileRemote,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: jobsKey });
      void queryClient.invalidateQueries({ queryKey: backupsKey });
      void queryClient.invalidateQueries({ queryKey: remoteBackupsKey });
    },
  });
}

// ---------------------------------------------------------------------------
// Updates (IMPLEMENTATION_PLAN.md §2.2)
// ---------------------------------------------------------------------------

export const updateStatusKey = ['maintenance', 'updates'] as const;

export function useUpdateStatusQuery() {
  return useQuery({ queryKey: updateStatusKey, queryFn: fetchUpdateStatus });
}

/**
 * Always settles as an error — the server refuses by design (see
 * `applyUpdate`). Exposed as a mutation anyway so the page renders the
 * refusal through the same error path as any other failed action, rather
 * than hard-coding a message the server might change.
 */
export function useApplyUpdateMutation() {
  return useMutation({ mutationFn: applyUpdate });
}

// ---------------------------------------------------------------------------
// Configuration editor (FEATURE_MATRIX.md §28-29)
// ---------------------------------------------------------------------------

export const configSettingsKey = ['maintenance', 'config', 'settings'] as const;
export const configSnapshotsKey = ['maintenance', 'config', 'snapshots'] as const;

export function useConfigSettingsQuery() {
  return useQuery({ queryKey: configSettingsKey, queryFn: fetchConfigSettings });
}

/**
 * A mutation, not a query: revealing a secret is an audited `POST`, so it
 * must be an explicit act and must never be re-run by a cache refetch.
 */
export function useRevealConfigSettingMutation() {
  return useMutation({ mutationFn: (key: string) => revealConfigSetting(key) });
}

/** Also a mutation despite being a pure read — validation is a `POST` of a proposed change set, which has no stable cache key. */
export function useValidateConfigMutation() {
  return useMutation({ mutationFn: (changes: ConfigChangeSet) => validateConfig(changes) });
}

export function useApplyConfigMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (changes: ConfigChangeSet) => applyConfig(changes),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: configSettingsKey });
      void queryClient.invalidateQueries({ queryKey: configSnapshotsKey });
    },
  });
}

export function useConfigSnapshotsQuery() {
  return useQuery({ queryKey: configSnapshotsKey, queryFn: fetchConfigSnapshots });
}

export function useRollbackConfigMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (snapshotId: string) => rollbackConfig(snapshotId),
    // A rollback is itself a config change (`config.service.ts`), so it
    // writes a new snapshot — the snapshot list changes too.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: configSettingsKey });
      void queryClient.invalidateQueries({ queryKey: configSnapshotsKey });
    },
  });
}
