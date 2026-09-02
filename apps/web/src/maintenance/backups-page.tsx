/**
 * `/maintenance/backups` (M10 — FEATURE_MATRIX.md §27, UX_ARCHITECTURE.md
 * §8). The most data-destructive screen in the product, so almost every
 * decision below is a refusal to be convenient:
 *
 *  - **Nothing is ever pre-selected.** No checked row, no implicit
 *    "latest backup", no default backup mode. Every destructive path
 *    starts from an explicit choice the admin made on this page.
 *  - **Destructive actions hide behind a menu**, never a row-level icon
 *    that sits one mis-click from mail data (§8).
 *  - **Restore is not offered below the `sm` breakpoint.** A four-tier
 *    flow (type-to-confirm, pre-flight, backup gate) on a phone is a
 *    data-loss hazard, so it is withheld — but stated in words, not
 *    silently dropped, because an admin who cannot find Restore must
 *    learn *why* rather than assume the product is broken.
 *  - **Progress is a job, never a spinner.** Create/verify/restore all
 *    return a job id; the bar below is `JobProgress` fed by the job
 *    stream, the same component the jobs page uses, so there is exactly
 *    one progress rendering in the product.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { CloudUpload, Download, MoreHorizontal } from 'lucide-react';
import {
  BACKUP_UPLOAD_STATUS_LABELS,
  BACKUP_VOLUME_CONTAINER_PATHS,
  BACKUP_VOLUME_KEYS,
  BACKUP_VOLUME_LABELS,
  isActiveJobStatus,
  type BackupMode,
  type BackupSummary,
  type BackupUploadStatus,
  type BackupVerificationStatus,
  type Job,
  type RestorePreflightResponse,
} from '@dwg/shared';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable, type DataTableColumn } from '@/components/data-table';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { MetricTile } from '@/components/metric-tile';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status/status-badge';
import type { Status } from '@/components/status/status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ApiClientError, ApiError } from '@/lib/api-client';
import { formatBytes, formatDateTime } from '@/lib/format';
import { JobProgress } from './jobs-page';
import {
  BackupScheduleCard,
  RemoteBrowseDialog,
  RemoteDestinationCard,
} from './backup-remote-settings';
import {
  backupDownloadUrl,
  useBackupDestinationQuery,
  useBackupScheduleQuery,
  useBackupsQuery,
  useCreateBackupMutation,
  useDeleteBackupMutation,
  useJobQuery,
  useJobStream,
  useRestoreBackupMutation,
  useRestorePreflightQuery,
  useUploadBackupMutation,
  useVerifyBackupMutation,
} from './use-maintenance-queries';

/**
 * The one place this page decides what a screen is too small for. Tailwind's
 * `sm` (40rem) is the first breakpoint the rest of the app already uses
 * (`sm:grid-cols-*`, the dialog footers), so Restore inherits it rather than
 * introducing a second, private idea of "mobile". Both halves are always in
 * the DOM and CSS picks one, which means no layout flash and no dependence
 * on a JS media query that would have to guess before first paint.
 */
const BELOW_SM_ONLY = 'sm:hidden';
/** `sm:flex`, not `sm:block` — every element this is applied to is a flex row in its own base classes, and `block` would silently undo that. */
const SM_AND_UP_ONLY = 'hidden sm:flex';

const BACKUP_MODE_LABELS: Readonly<Record<BackupMode, string>> = {
  warm: 'Warm',
  cold: 'Cold',
};

/**
 * The mode caveats, stated at the point of choice rather than in
 * documentation. `warm` is the schema's nominal default, but this page
 * still never preselects it: the difference between the two is live mail
 * data versus downtime, and that is the admin's call to make out loud.
 */
const BACKUP_MODE_CAVEATS: Readonly<Record<BackupMode, string>> = {
  warm: 'The container keeps running, so mail data is live while it is read. The archive may catch a message mid-delivery — no downtime, slightly weaker consistency.',
  cold: 'The managed container is stopped first, producing a consistent archive. Mail is not delivered or served for the duration of the backup.',
};

const VERIFICATION_LABELS: Readonly<Record<BackupVerificationStatus, string>> = {
  unverified: 'Not verified',
  verified: 'Verified',
  failed: 'Verification failed',
};

/**
 * Verification -> the six-state vocabulary (§3.3). `unverified` is grey
 * `unknown`, not `warning`: nothing is wrong with an archive nobody has
 * checked yet, we simply do not know that it is good — which is exactly
 * what §3.3 reserves grey for.
 */
const VERIFICATION_TONE: Readonly<Record<BackupVerificationStatus, Status>> = {
  unverified: 'unknown',
  verified: 'healthy',
  failed: 'critical',
};

/**
 * Upload state -> the status vocabulary (§3.3). `pending` is grey `unknown`
 * (a backup nobody has uploaded yet is not "wrong"), `uploading` is the
 * spinner, `uploaded` healthy, `failed` critical.
 */
const UPLOAD_TONE: Readonly<Record<BackupUploadStatus, Status>> = {
  pending: 'unknown',
  uploading: 'pending',
  uploaded: 'healthy',
  failed: 'critical',
};

function errorIdOf(error: unknown): string {
  return error instanceof ApiError || error instanceof ApiClientError ? error.errorId : 'unknown';
}

function errorMessageOf(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/** Volumes in the schema's declared order, never the server's array order, so two rows never disagree about how a backup is described. */
function orderedVolumeKeys(backup: BackupSummary): readonly (typeof BACKUP_VOLUME_KEYS)[number][] {
  const present = new Set(backup.volumes.map((volume) => volume.key));
  return BACKUP_VOLUME_KEYS.filter((key) => present.has(key));
}

/** What the confirm dialogs call the backup, and what tier 3/4 asks to be typed — its opaque id, the only thing that identifies it unambiguously. */
function backupLabel(backup: BackupSummary): string {
  return backup.id;
}

/** The job kinds this page starts, so the progress card can say which one is running instead of "a job". */
type StartedJobKind = 'create' | 'verify' | 'restore' | 'upload' | 'import';

const STARTED_JOB_LABELS: Readonly<Record<StartedJobKind, string>> = {
  create: 'Creating backup',
  verify: 'Verifying backup',
  restore: 'Restoring backup',
  upload: 'Uploading to remote',
  import: 'Importing from remote',
};

interface StartedJob {
  readonly id: string;
  readonly kind: StartedJobKind;
}

/**
 * The pre-flight report, rendered from exactly the fields
 * `RestorePreflightResponseSchema` defines and no others. In particular the
 * vmail ownership warning is the server's own `vmailOwnershipNote` string
 * verbatim — this page does not restate a UID/GID pair of its own, because
 * a number invented here could drift from the one the restore actually
 * uses, and a confidently wrong ownership claim is worse than none.
 */
function RestorePreflightReport({ preflight }: { readonly preflight: RestorePreflightResponse }) {
  const blockers: readonly string[] = [
    ...(preflight.containerRunning
      ? ['The managed container is still running. Restore needs it stopped and will be refused.']
      : []),
    ...(!preflight.manifestCompatible
      ? [
          preflight.compatibilityMessage ??
            'This archive is not compatible with the image currently running.',
        ]
      : []),
  ];

  return (
    <div className="flex flex-col gap-2">
      <p className="font-medium text-text-primary">Pre-flight</p>

      {blockers.length > 0 ? (
        <ul className="flex list-disc flex-col gap-1 pl-4 text-status-critical-fg">
          {blockers.map((blocker) => (
            <li key={blocker}>{blocker}</li>
          ))}
        </ul>
      ) : (
        <p className="text-status-healthy-fg">
          Container stopped and archive compatible with the running image.
        </p>
      )}

      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
        <div className="flex gap-2">
          <dt className="text-text-muted">Container</dt>
          <dd>{preflight.containerRunning ? 'Running' : 'Stopped'}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-text-muted">Archive compatible</dt>
          <dd>{preflight.manifestCompatible ? 'Yes' : 'No'}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-text-muted">Running image</dt>
          <dd className="font-mono-sm break-all">
            {preflight.currentDmsImageDigest ?? 'Could not be resolved'}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-text-muted">Archive image</dt>
          <dd className="font-mono-sm break-all">
            {preflight.backup.dmsImageDigest ?? 'Not recorded'}
          </dd>
        </div>
      </dl>

      <p>
        Overwrites{' '}
        {orderedVolumeKeys(preflight.backup)
          .map((key) => BACKUP_VOLUME_CONTAINER_PATHS[key])
          .join(', ')}{' '}
        with the contents of this archive.
      </p>

      {/* The server's own wording, unedited — see this component's comment. */}
      <p className="text-text-primary">{preflight.vmailOwnershipNote}</p>
    </div>
  );
}

/**
 * `/maintenance/backups` — list, create, verify, download, delete, restore.
 */
export function BackupsPage() {
  const navigate = useNavigate();
  const backupsQuery = useBackupsQuery();
  const createMutation = useCreateBackupMutation();
  const verifyMutation = useVerifyBackupMutation();
  const deleteMutation = useDeleteBackupMutation();
  const uploadMutation = useUploadBackupMutation();
  const destinationQuery = useBackupDestinationQuery();
  const scheduleQuery = useBackupScheduleQuery();
  const remoteConfigured = destinationQuery.data?.configured ?? false;
  const schedule = scheduleQuery.data;

  const [browseOpen, setBrowseOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  // `null`, not `'warm'`: the mode dialog opens with neither option chosen
  // and Create stays refused until the admin picks one.
  const [createMode, setCreateMode] = useState<BackupMode | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BackupSummary | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<BackupSummary | null>(null);
  const [startedJob, setStartedJob] = useState<StartedJob | null>(null);

  // Restore is per-backup, so its mutation and its pre-flight are both keyed
  // to whichever backup the dialog is open on — `''` while none is, which
  // both hooks treat as "disabled" rather than as a request.
  const restoreBackupId = restoreTarget?.id ?? '';
  const preflightQuery = useRestorePreflightQuery(restoreBackupId);
  const restoreMutation = useRestoreBackupMutation(restoreBackupId);

  const startedJobId = startedJob?.id ?? '';
  const jobStream = useJobStream(startedJobId);
  const jobQuery = useJobQuery(startedJobId);
  // Stream frames are fresher than the cached row whenever they exist; the
  // query is the fallback until the first frame lands and the only source
  // for a job that finished before this card rendered.
  const runningJob: Job | null = jobStream.job ?? jobQuery.data?.job ?? null;

  // A finished job is the only honest trigger for refreshing the table: the
  // mutations invalidate when the job is *enqueued*, which is long before
  // the archive exists.
  const runningJobStatus = runningJob?.status;
  useEffect(() => {
    if (runningJobStatus === undefined) return;
    if (isActiveJobStatus(runningJobStatus)) return;
    void backupsQuery.refetch();
    // `backupsQuery` is a new object every render, so depending on it would
    // refetch in a loop; the status transition is the real dependency, and
    // `refetch` is stable across renders. (No disable directive here:
    // eslint-plugin-react-hooks is not in the tooling budget, and naming a
    // rule that isn't installed is itself a lint error.)
  }, [runningJobStatus]);

  const backups = backupsQuery.data ?? [];

  const totals = useMemo(() => {
    const verified = backups.filter((backup) => backup.verificationStatus === 'verified');
    const mostRecentVerified = verified.reduce<string | null>(
      (latest, backup) =>
        latest === null || backup.createdAt.localeCompare(latest) > 0 ? backup.createdAt : latest,
      null,
    );
    return {
      count: backups.length,
      sizeBytes: backups.reduce((sum, backup) => sum + backup.sizeBytes, 0),
      verifiedCount: verified.length,
      mostRecentVerified,
    };
  }, [backups]);

  const columns = useMemo<DataTableColumn<BackupSummary>[]>(
    () => [
      {
        id: 'createdAt',
        header: 'Created',
        sortValue: (row) => row.createdAt,
        cell: (row) => (
          <div className="flex flex-col">
            <span className="font-medium text-text-primary">{formatDateTime(row.createdAt)}</span>
            <span className="font-mono-sm text-text-muted">{row.id}</span>
          </div>
        ),
      },
      {
        id: 'mode',
        header: 'Mode',
        sortValue: (row) => row.mode,
        cell: (row) => <Badge variant="neutral">{BACKUP_MODE_LABELS[row.mode]}</Badge>,
      },
      {
        id: 'size',
        header: 'Size',
        sortValue: (row) => row.sizeBytes,
        cell: (row) => formatBytes(row.sizeBytes),
      },
      {
        id: 'contents',
        header: 'Contents',
        cell: (row) => (
          <ul className="flex flex-wrap gap-1">
            {orderedVolumeKeys(row).map((key) => (
              <li key={key}>
                <Badge variant="neutral">{BACKUP_VOLUME_LABELS[key]}</Badge>
              </li>
            ))}
          </ul>
        ),
      },
      {
        id: 'verification',
        header: 'Verification',
        sortValue: (row) => row.verificationStatus,
        cell: (row) => (
          <div className="flex flex-col gap-1">
            <StatusBadge
              status={VERIFICATION_TONE[row.verificationStatus]}
              label={VERIFICATION_LABELS[row.verificationStatus]}
            />
            {row.verifiedAt !== null ? (
              <span className="text-caption text-text-muted">
                Checked {formatDateTime(row.verifiedAt)}
              </span>
            ) : null}
          </div>
        ),
      },
      {
        id: 'upload',
        header: 'Remote',
        sortValue: (row) => row.uploadStatus,
        cell: (row) => (
          <div className="flex flex-col gap-1">
            <StatusBadge
              status={UPLOAD_TONE[row.uploadStatus]}
              label={BACKUP_UPLOAD_STATUS_LABELS[row.uploadStatus]}
            />
            {!row.localPresent ? (
              <span className="text-caption text-text-muted">Remote only</span>
            ) : null}
          </div>
        ),
      },
      {
        id: 'createdBy',
        header: 'Created by',
        sortValue: (row) => row.createdByLabel,
        cell: (row) => row.createdByLabel,
      },
    ],
    [],
  );

  const startCreate = () => {
    if (createMode === null) {
      toast.error('Choose warm or cold before creating the backup.');
      return;
    }
    createMutation.mutate(createMode, {
      onSuccess: (jobId) => {
        setCreateOpen(false);
        setCreateMode(null);
        setStartedJob({ id: jobId, kind: 'create' });
        toast.success('Backup started');
      },
      onError: (error) => toast.error(errorMessageOf(error, 'Could not start the backup')),
    });
  };

  const startVerify = (backup: BackupSummary) => {
    verifyMutation.mutate(backup.id, {
      onSuccess: (jobId) => {
        setStartedJob({ id: jobId, kind: 'verify' });
        toast.success('Verification started');
      },
      onError: (error) => toast.error(errorMessageOf(error, 'Could not start verification')),
    });
  };

  const startUpload = (backup: BackupSummary) => {
    uploadMutation.mutate(backup.id, {
      onSuccess: (jobId) => {
        setStartedJob({ id: jobId, kind: 'upload' });
        toast.success(backup.uploadStatus === 'failed' ? 'Retrying upload' : 'Upload started');
      },
      onError: (error) => toast.error(errorMessageOf(error, 'Could not start the upload')),
    });
  };

  const confirmRestore = () => {
    if (restoreTarget === null) return;
    const preflight = preflightQuery.data;
    if (preflight === undefined) {
      toast.error('Pre-flight has not finished. Restore cannot proceed without it.');
      return;
    }
    if (preflight.containerRunning) {
      toast.error('Stop the managed container before restoring.');
      return;
    }
    if (!preflight.manifestCompatible) {
      toast.error(preflight.compatibilityMessage ?? 'This archive is not compatible.');
      return;
    }
    restoreMutation.mutate(
      {
        confirm: true,
        // Derived from the gate the dialog itself enforced, never hardcoded:
        // when `recentVerifiedBackupExists` is false the ConfirmDialog keeps
        // Restore disabled until the acknowledgement checkbox is ticked, so
        // reaching this line *is* the acknowledgement. When it is true the
        // schema ignores the field, and `false` claims nothing.
        acknowledgeNoRecentBackup: !preflight.recentVerifiedBackupExists,
      },
      {
        onSuccess: (jobId) => {
          setRestoreTarget(null);
          setStartedJob({ id: jobId, kind: 'restore' });
          toast.success('Restore started');
        },
        onError: (error) => toast.error(errorMessageOf(error, 'Could not start the restore')),
      },
    );
  };

  const confirmDelete = () => {
    if (deleteTarget === null) return;
    const target = deleteTarget;
    deleteMutation.mutate(target.id, {
      onSuccess: () => {
        setDeleteTarget(null);
        toast.success('Backup deleted');
      },
      onError: (error) => toast.error(errorMessageOf(error, 'Could not delete this backup')),
    });
  };

  const preflight = preflightQuery.data;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Backups"
        description="Archives of the four mail data volumes. Creating, verifying and restoring all run as background jobs."
        action={
          <div className="flex flex-wrap gap-2">
            {remoteConfigured ? (
              <Button variant="secondary" onClick={() => setBrowseOpen(true)}>
                <CloudUpload className="size-4" aria-hidden="true" />
                Browse remote
              </Button>
            ) : null}
            <Button onClick={() => setCreateOpen(true)}>Create backup</Button>
          </div>
        }
      />

      {/*
        Stated once, at the top, rather than only inside the restore dialog:
        an admin on a phone should learn that Restore is missing on purpose
        before they go hunting for it in a menu.
      */}
      <p
        className={`${BELOW_SM_ONLY} rounded-sm border border-border-subtle bg-bg-inset px-3 py-2 text-body-sm text-text-secondary`}
      >
        Restore is not available on a screen this small. It overwrites live mail data behind a
        four-step confirmation, and that flow is too easy to mis-tap on a phone — open this page on
        a larger screen to restore. Everything else here works normally.
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile label="Backups" value={totals.count} />
        <MetricTile label="Total size" value={formatBytes(totals.sizeBytes)} />
        <MetricTile
          label="Most recent verified"
          value={
            totals.mostRecentVerified === null ? 'None' : formatDateTime(totals.mostRecentVerified)
          }
        />
        <MetricTile
          label="Next scheduled backup"
          value={
            schedule === undefined || !schedule.enabled || schedule.nextRunAt === null
              ? 'Off'
              : formatDateTime(schedule.nextRunAt)
          }
        />
      </div>

      {/*
        Remote destination + schedule. Kept below the summary tiles and above
        the list so configuring where backups go, and how often, is discoverable
        without dominating the page. The two components own their own loading,
        save and secret-reveal behaviour (see backup-remote-settings.tsx).
      */}
      <div className="grid gap-4 lg:grid-cols-2">
        <RemoteDestinationCard />
        <BackupScheduleCard />
      </div>

      {startedJob !== null && runningJob !== null ? (
        <Card>
          <CardHeader>
            <CardTitle>{STARTED_JOB_LABELS[startedJob.kind]}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <JobProgress job={runningJob} size="lg" />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => navigate(`/maintenance/jobs/${encodeURIComponent(startedJob.id)}`)}
              >
                View job log
              </Button>
              {!isActiveJobStatus(runningJob.status) ? (
                <Button variant="ghost" size="sm" onClick={() => setStartedJob(null)}>
                  Dismiss
                </Button>
              ) : null}
              {runningJob.status === 'failed' && runningJob.errorMessage !== null ? (
                <span className="text-body-sm text-status-critical-fg">
                  {runningJob.errorMessage}
                </span>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {backupsQuery.isError ? (
        <ErrorState
          message="Could not load the backup list."
          errorId={errorIdOf(backupsQuery.error)}
          onRetry={() => void backupsQuery.refetch()}
        />
      ) : (
        <DataTable
          data={backups}
          columns={columns}
          getRowId={(row) => row.id}
          caption="Backup archives"
          isLoading={backupsQuery.isLoading}
          initialSort={{ id: 'createdAt', desc: true }}
          emptyState={
            <EmptyState
              variant="first-run"
              title="No backups yet"
              description="A backup archives all four mail data volumes into one file you can download and restore. Nothing here is backed up until you create one."
              action={{ label: 'Create backup', onClick: () => setCreateOpen(true) }}
            />
          }
          /*
            Deliberately no `selectedIds`/`onSelectedIdsChange`: selection
            would imply a bulk destructive action, and there is none here.
            No row is ever pre-selected because no row is selectable at all.
          */
          rowActions={(row) => (
            <div className="flex justify-end">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label={`Actions for backup ${row.id}`}>
                    <MoreHorizontal className="size-4" aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => startVerify(row)}>
                    Verify archive
                  </DropdownMenuItem>
                  {/*
                    A real anchor, not a fetch: the response is a binary tar
                    with its own `content-disposition`, and routing it through
                    JavaScript would buffer the whole archive in memory for
                    no benefit.
                  */}
                  <DropdownMenuItem asChild>
                    <a href={backupDownloadUrl(row.id)} download>
                      <Download className="size-4" aria-hidden="true" />
                      Download archive
                    </a>
                  </DropdownMenuItem>

                  {remoteConfigured &&
                  row.localPresent &&
                  (row.uploadStatus === 'pending' || row.uploadStatus === 'failed') ? (
                    <DropdownMenuItem onClick={() => startUpload(row)}>
                      <CloudUpload className="size-4" aria-hidden="true" />
                      {row.uploadStatus === 'failed' ? 'Retry upload' : 'Upload to remote'}
                    </DropdownMenuItem>
                  ) : null}

                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Destructive</DropdownMenuLabel>

                  {/*
                    Both variants are always in the DOM and CSS chooses; the
                    small-screen one is a disabled item that says why, so the
                    absence reads as a decision rather than a bug. The class
                    goes on the item itself rather than a wrapper, so Radix's
                    roving focus still sees a flat list of items.
                  */}
                  <DropdownMenuItem
                    destructive
                    className={SM_AND_UP_ONLY}
                    onClick={() => setRestoreTarget(row)}
                  >
                    Restore from this backup…
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled className={BELOW_SM_ONLY}>
                    Restore — needs a larger screen
                  </DropdownMenuItem>

                  <DropdownMenuItem destructive onClick={() => setDeleteTarget(row)}>
                    Delete backup…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        />
      )}

      {/*
        Create is a plain form dialog, not a ConfirmDialog: it asks a
        question with no default answer rather than confirming a decision
        already made. The mode radios start unchecked for that reason.
      */}
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) setCreateMode(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create backup</DialogTitle>
            <DialogDescription>
              Archives all four mail data volumes into one file. This runs as a background job.
            </DialogDescription>
          </DialogHeader>

          <fieldset className="flex flex-col gap-3">
            <legend className="text-body-sm font-medium text-text-primary">
              Backup mode — this choice has no default
            </legend>
            {(['warm', 'cold'] as const).map((mode) => (
              <label key={mode} className="flex items-start gap-2 text-body-sm">
                <input
                  type="radio"
                  name="backup-mode"
                  className="mt-1"
                  checked={createMode === mode}
                  onChange={() => setCreateMode(mode)}
                />
                <span className="flex flex-col gap-0.5">
                  <span className="font-medium text-text-primary">{BACKUP_MODE_LABELS[mode]}</span>
                  <span className="text-text-secondary">{BACKUP_MODE_CAVEATS[mode]}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setCreateOpen(false);
                setCreateMode(null);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={createMode === null}
              pending={createMutation.isPending}
              onClick={startCreate}
            >
              Create backup
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Tier 3 (§8): type-to-confirm plus a required impact summary. */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        tier={3}
        destructive
        title="Delete this backup?"
        description="The archive is removed from disk permanently. Nothing else changes — this does not touch live mail data."
        impactSummary={
          deleteTarget === null ? null : (
            <div className="flex flex-col gap-1">
              <span>
                Permanently deletes the {formatBytes(deleteTarget.sizeBytes)} archive created{' '}
                {formatDateTime(deleteTarget.createdAt)}, covering{' '}
                {orderedVolumeKeys(deleteTarget)
                  .map((key) => BACKUP_VOLUME_LABELS[key])
                  .join(', ')}
                .
              </span>
              {deleteTarget.verificationStatus === 'verified' ? (
                <span>
                  This is a verified backup. Deleting it may leave the system with no recent
                  verified backup, which other operations check before they proceed.
                </span>
              ) : null}
            </div>
          )
        }
        resourceName={deleteTarget === null ? '' : backupLabel(deleteTarget)}
        confirmLabel="Delete backup"
        pending={deleteMutation.isPending}
        onConfirm={confirmDelete}
      />

      {/*
        Tier 4 (§8): tier 3 plus a real pre-flight and the backup gate. The
        gate's `verified` is the pre-flight's `recentVerifiedBackupExists` —
        a fact about the data about to be overwritten, not about the archive
        doing the overwriting.
      */}
      <ConfirmDialog
        open={restoreTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRestoreTarget(null);
        }}
        tier={4}
        destructive
        title="Restore from this backup?"
        description="This overwrites live mail data with the contents of the archive. Anything newer than the archive is lost and cannot be recovered."
        impactSummary={
          restoreTarget === null ? null : (
            <span>
              Overwrites{' '}
              {orderedVolumeKeys(restoreTarget)
                .map((key) => BACKUP_VOLUME_LABELS[key])
                .join(', ')}{' '}
              with the archive created {formatDateTime(restoreTarget.createdAt)}.
            </span>
          )
        }
        preflight={
          preflightQuery.isError ? (
            <span className="text-status-critical-fg">
              Pre-flight could not be run ({errorIdOf(preflightQuery.error)}). Restore cannot
              proceed without it.
            </span>
          ) : preflight === undefined ? (
            <span>Running pre-flight checks…</span>
          ) : (
            <RestorePreflightReport preflight={preflight} />
          )
        }
        backup={
          preflight === undefined
            ? {
                verified: false,
                description: 'Backup status unknown — pre-flight has not finished.',
              }
            : {
                verified: preflight.recentVerifiedBackupExists,
                description: preflight.recentVerifiedBackupExists
                  ? `A recent verified backup of the current data exists${
                      preflight.mostRecentVerifiedBackupAt === null
                        ? ''
                        : ` (${formatDateTime(preflight.mostRecentVerifiedBackupAt)})`
                    }.`
                  : 'No recent verified backup of the current data exists. If this restore is wrong, there is nothing to go back to.',
              }
        }
        resourceName={restoreTarget === null ? '' : backupLabel(restoreTarget)}
        confirmLabel="Restore"
        pending={restoreMutation.isPending}
        onConfirm={confirmRestore}
      />

      {/*
        Browse-remote + import (restore-from-remote, step one). Importing pulls
        and verifies the archive server-side; it then joins the list above,
        where the four-tier Restore takes over — restore keeps every gate.
      */}
      <RemoteBrowseDialog
        open={browseOpen}
        onOpenChange={setBrowseOpen}
        onImportStarted={(jobId) => setStartedJob({ id: jobId, kind: 'import' })}
      />
    </div>
  );
}
