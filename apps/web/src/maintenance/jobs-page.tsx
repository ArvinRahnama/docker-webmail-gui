/**
 * `/maintenance/jobs` and `/maintenance/jobs/:id` (M10 — ARCHITECTURE.md
 * §7.5, §8). Backup, verify and restore outlive a request, so the only
 * honest way to show them is a job list plus a live detail view fed by the
 * SSE stream (`useJobStream`).
 *
 * Two rules shape almost every decision below:
 *  - Progress is only ever what the runner reported. `Job.progress` never
 *    advances on its own, so a running job sitting at 0 is rendered as
 *    "running, no measured progress yet" — never a spinner or an
 *    indeterminate bar, both of which would imply movement the server has
 *    not claimed.
 *  - The stream is a push channel, not a history. `logs` from
 *    `useJobStream` covers this connection only; anything written before
 *    the page opened comes from `useJobQuery`, so the detail view merges
 *    the two rather than pretending the stream is the whole record.
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, X } from 'lucide-react';
import {
  isActiveJobStatus,
  type Job,
  type JobLogEntry,
  type JobLogLevel,
  type JobStatus,
  type JobType,
} from '@dwg/shared';
import { BreakableText } from '@/components/breakable-text';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable, type DataTableColumn } from '@/components/data-table';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status/status-badge';
import type { Status } from '@/components/status/status';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiClientError, ApiError } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import {
  useCancelJobMutation,
  useJobQuery,
  useJobStream,
  useJobsQuery,
} from './use-maintenance-queries';

/** `JOB_TYPES` is a closed set, so this is exhaustive by construction — a new type will not compile until it is named here. */
const JOB_TYPE_LABELS: Readonly<Record<JobType, string>> = {
  'backup.create': 'Create backup',
  'backup.verify': 'Verify backup',
  'backup.restore': 'Restore backup',
  'backup.upload': 'Upload backup to remote',
  'backup.import': 'Import backup from remote',
  'panel.selfUpdate': 'Panel self-update',
};

const JOB_STATUS_LABELS: Readonly<Record<JobStatus, string>> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/**
 * Job status -> the six-state vocabulary (UX_ARCHITECTURE.md §3.3). Only
 * `running` maps to `pending`, whose badge spins: that job really is doing
 * work. `queued` maps to the neutral `info` instead, because a spinner on
 * a job nothing has started yet would claim activity that is not happening.
 * `cancelled` is `warning`, not `unknown`: we know exactly what happened
 * (an admin stopped it), and the requested work did not complete — whereas
 * §3.3 reserves grey `unknown` for "we could not determine this".
 */
const JOB_STATUS_TONE: Readonly<Record<JobStatus, Status>> = {
  queued: 'info',
  running: 'pending',
  succeeded: 'healthy',
  failed: 'critical',
  cancelled: 'warning',
};

const LOG_LEVEL_LABELS: Readonly<Record<JobLogLevel, string>> = {
  info: 'Info',
  warn: 'Warning',
  error: 'Error',
};

/**
 * Level styling carries a text label as well as colour (§2 principle 5 —
 * never colour alone), so `warn` and `error` survive both greyscale and
 * colour-vision differences.
 */
const LOG_LEVEL_CLASSNAMES: Readonly<Record<JobLogLevel, string>> = {
  info: 'text-text-secondary',
  warn: 'bg-status-warning-bg text-status-warning-fg',
  error: 'bg-status-critical-bg text-status-critical-fg',
};

function errorIdOf(error: unknown): string {
  return error instanceof ApiError || error instanceof ApiClientError ? error.errorId : 'unknown';
}

/** True only for a 404 from the API — the difference between "this job id does not exist" and "the request failed". */
function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.httpStatus === 404;
}

/**
 * `metadata` is `JsonValue`, so it is narrowed rather than cast: anything
 * that is not an object carrying a string `backupId` simply yields `null`
 * and no metadata line is rendered. Narrowing goes through `in` rather
 * than `Array.isArray` because the latter's `arg is any[]` predicate does
 * not subtract a *readonly* array from the union — `in` checks the actual
 * property and leaves the value `unknown`, which the `typeof` below then
 * has to earn. Never `as`, never `!`.
 */
function backupIdOf(metadata: Job['metadata']): string | null {
  if (typeof metadata !== 'object' || metadata === null) return null;
  if (!('backupId' in metadata)) return null;
  const value: unknown = metadata.backupId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** How progress reads for a job in this status, given the runner-reported number. */
function progressLabel(job: Job): string {
  if (job.status === 'queued') return 'Not started';
  if (job.status === 'running' && job.progress === 0) return 'No measured progress yet';
  return `${job.progress}%`;
}

interface JobProgressProps {
  readonly job: Job;
  /** Sizing only — the semantics are identical in the list and on the detail page. */
  readonly size?: 'sm' | 'lg';
}

/**
 * The one place a progress number becomes a bar. `aria-valuenow` is always
 * the real reported number, and the bar is deliberately *not* inside a live
 * region: a streaming job can push snapshots every few hundred ms, and
 * announcing each one would make the page unusable with a screen reader
 * (§ accessibility). The number stays readable on demand instead.
 */
export function JobProgress({ job, size = 'sm' }: JobProgressProps) {
  const label = progressLabel(job);
  return (
    <div className="flex flex-col gap-1">
      <div
        role="progressbar"
        aria-valuenow={job.progress}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={label}
        aria-label={`${JOB_TYPE_LABELS[job.type]} progress`}
        className={cn(
          'w-full overflow-hidden rounded-full bg-bg-inset',
          size === 'lg' ? 'h-2.5' : 'h-1.5',
        )}
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-fast',
            job.status === 'failed' ? 'bg-status-critical-fg' : 'bg-accent',
          )}
          style={{ width: `${job.progress}%` }}
        />
      </div>
      <span className={cn('text-text-secondary', size === 'lg' ? 'text-body-sm' : 'text-caption')}>
        {label}
      </span>
    </div>
  );
}

interface JobLogListProps {
  readonly entries: readonly JobLogEntry[];
}

/**
 * `role="log"` is avoided on purpose: it carries an implicit
 * `aria-live="polite"`, which on a chatty restore would read every line
 * aloud as it lands. This is a labelled region an admin can read at will.
 */
function JobLogList({ entries }: JobLogListProps) {
  if (entries.length === 0) {
    return <p className="text-body-sm text-text-secondary">No log lines yet.</p>;
  }
  return (
    <ol
      aria-label="Job log"
      className="max-h-[24rem] overflow-auto rounded-sm bg-bg-inset p-2 font-mono-sm"
    >
      {entries.map((entry) => (
        // Wraps rather than squeezing: on a phone the timestamp and level
        // keep one line and the message drops below them at full width,
        // instead of getting whatever is left beside two shrink-0 spans.
        <li
          key={entry.id}
          className="flex flex-wrap items-start gap-x-2 gap-y-0.5 rounded-sm px-1 py-0.5"
        >
          <span className="shrink-0 text-text-muted">{formatDateTime(entry.loggedAt)}</span>
          <span
            className={cn(
              'shrink-0 rounded-sm px-1 font-semibold uppercase',
              LOG_LEVEL_CLASSNAMES[entry.level],
            )}
          >
            {LOG_LEVEL_LABELS[entry.level]}
          </span>
          <span className="min-w-0 flex-[1_1_16rem] wrap-anywhere text-text-primary">
            {entry.message}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * `/maintenance/jobs` — every job the runner knows about. Cancel is offered
 * strictly for `JOB_ACTIVE_STATUSES` (via `isActiveJobStatus`, not a
 * re-derived list), and is a tier 1 confirmation: UX_ARCHITECTURE.md §8
 * standard dialog, destructive styling, Cancel focused rather than the
 * destructive button.
 */
export function JobsPage() {
  const navigate = useNavigate();
  const jobsQuery = useJobsQuery();
  const cancelMutation = useCancelJobMutation();
  const [pendingCancel, setPendingCancel] = useState<Job | null>(null);

  const columns = useMemo<DataTableColumn<Job>[]>(
    () => [
      {
        id: 'type',
        header: 'Job',
        sortValue: (row) => JOB_TYPE_LABELS[row.type],
        cell: (row) => (
          // The floor keeps the label, id and date readable: without it the
          // table squeezes this column to its longest word and every row turns
          // into a tower of one-word lines. It is lowest below sm, where the
          // id is hidden and Status and Cancel need the rest of a 320px screen.
          <div className="flex min-w-24 flex-col sm:min-w-32 lg:min-w-40">
            {/*
              The row's primary way in — on a phone the only one, since the
              trailing View button is hidden there.
            */}
            <Link
              to={`/maintenance/jobs/${encodeURIComponent(row.id)}`}
              className="font-medium text-accent hover:underline"
            >
              {JOB_TYPE_LABELS[row.type]}
            </Link>
            {/* One unbreakable token; the detail page shows it on phones. */}
            <span className="hidden font-mono-sm break-all text-text-muted sm:block">{row.id}</span>
            {/* Stands in for the Created column, which is hidden below lg. */}
            <span className="text-caption text-text-muted lg:hidden">
              {formatDateTime(row.createdAt)}
            </span>
          </div>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        sortValue: (row) => row.status,
        cell: (row) => (
          <div className="flex flex-col items-start gap-1">
            <StatusBadge
              status={JOB_STATUS_TONE[row.status]}
              label={JOB_STATUS_LABELS[row.status]}
            />
            {/* Stands in for the Progress column wherever that is hidden (see below). */}
            <span className="block text-caption text-text-secondary sm:hidden md:block lg:hidden">
              {progressLabel(row)}
            </span>
            {row.status === 'failed' && row.errorMessage !== null ? (
              // §9: a failed job states why on the list itself — an admin
              // should not have to open the detail view to learn that much.
              // The md floor stops a crowded desktop table squeezing the
              // message into a one-word-wide column many lines tall.
              <span className="max-w-xs text-caption wrap-anywhere text-status-critical-fg md:min-w-40">
                {row.errorMessage}
              </span>
            ) : null}
          </div>
        ),
      },
      {
        id: 'progress',
        header: 'Progress',
        sortValue: (row) => row.progress,
        // Shown only where the table has room for it: not on a phone, and not
        // at md, where the sidebar leaves a phone-sized content area. There the
        // Status cell carries the progress label instead.
        headerClassName: 'hidden sm:table-cell md:hidden lg:table-cell',
        cellClassName: 'hidden w-40 sm:table-cell md:hidden lg:table-cell',
        cell: (row) => <JobProgress job={row} />,
      },
      {
        id: 'createdBy',
        header: 'Started by',
        sortValue: (row) => row.createdByLabel,
        // min-w keeps an ordinary address on one line when the table is
        // tight; a longer one breaks after its dots and `@` rather than
        // mid-word, and never widens the column past the table's scroller.
        cell: (row) => (
          <span className="inline-block min-w-32 break-words">
            <BreakableText text={row.createdByLabel} />
          </span>
        ),
        // Low-value columns give way first on narrow screens, so Job, Status
        // and Progress stay readable without a sideways scroll; the job
        // detail page still shows all of them.
        headerClassName: 'hidden xl:table-cell',
        cellClassName: 'hidden xl:table-cell',
      },
      {
        id: 'createdAt',
        header: 'Created',
        sortValue: (row) => row.createdAt,
        cell: (row) => formatDateTime(row.createdAt),
        headerClassName: 'hidden lg:table-cell',
        cellClassName: 'hidden lg:table-cell',
      },
      {
        id: 'startedAt',
        header: 'Started',
        sortValue: (row) => row.startedAt ?? '',
        cell: (row) => formatDateTime(row.startedAt),
        // The least telling stamp (usually Created to the minute), so it is
        // the first to go: at 1280px the table needs its width for a failed
        // job's message.
        headerClassName: 'hidden 2xl:table-cell',
        cellClassName: 'hidden 2xl:table-cell',
      },
      {
        id: 'finishedAt',
        header: 'Finished',
        sortValue: (row) => row.finishedAt ?? '',
        cell: (row) => formatDateTime(row.finishedAt),
        headerClassName: 'hidden xl:table-cell',
        cellClassName: 'hidden xl:table-cell',
      },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Jobs"
        description="Backups, verifications and restores run in the background. Open one to watch its progress and log."
      />

      {jobsQuery.isError ? (
        <ErrorState
          message="Could not load the job list."
          errorId={errorIdOf(jobsQuery.error)}
          onRetry={() => void jobsQuery.refetch()}
        />
      ) : (
        <DataTable
          data={jobsQuery.data ?? []}
          columns={columns}
          getRowId={(row) => row.id}
          caption="Background jobs"
          isLoading={jobsQuery.isLoading}
          initialSort={{ id: 'createdAt', desc: true }}
          emptyState={
            <EmptyState
              variant="first-run"
              title="No jobs yet"
              description="Creating, verifying or restoring a backup runs as a job, and every one of them appears here."
            />
          }
          rowActions={(row) => (
            <div className="flex flex-wrap justify-end gap-1">
              {/* Below sm the job label link opens the job; View would only push Cancel off screen. */}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="hidden sm:inline-flex"
                onClick={() => navigate(`/maintenance/jobs/${encodeURIComponent(row.id)}`)}
              >
                View
              </Button>
              {/* Cancellability is `isActiveJobStatus`, never a second list of statuses that could drift from it. */}
              {isActiveJobStatus(row.status) ? (
                // Icon-only below sm so it stays on screen beside Job and
                // Status; the label remains the accessible name at every size.
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="max-sm:px-1.5"
                  onClick={() => setPendingCancel(row)}
                >
                  <X className="sm:hidden" aria-hidden="true" />
                  <span className="max-sm:sr-only">Cancel job</span>
                </Button>
              ) : null}
            </div>
          )}
        />
      )}

      <ConfirmDialog
        open={pendingCancel !== null}
        onOpenChange={(open) => {
          if (!open) setPendingCancel(null);
        }}
        tier={1}
        title="Cancel this job?"
        description={
          pendingCancel === null
            ? ''
            : `${JOB_TYPE_LABELS[pendingCancel.type]} will stop where it is and finish as cancelled. Any work it had already done is not undone.`
        }
        confirmLabel="Cancel job"
        cancelLabel="Keep running"
        destructive
        pending={cancelMutation.isPending}
        onConfirm={() => {
          if (pendingCancel === null) return;
          cancelMutation.mutate(pendingCancel.id, {
            onSuccess: () => {
              setPendingCancel(null);
              toast.success('Job cancelled');
            },
            onError: () => toast.error('Could not cancel this job'),
          });
        }}
      />
    </div>
  );
}

/**
 * `/maintenance/jobs/:id` — live progress and log for one job.
 *
 * Existence is settled by `useJobQuery`, not by the stream: `EventSource`
 * cannot surface a 404 body, so a bad id would otherwise sit at
 * `connected: false` forever and read as "connecting" when the job simply
 * does not exist. The query answers that question once; the stream then
 * only ever supplies fresher state for a job we know is real.
 */
export function JobDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const jobQuery = useJobQuery(id);
  const stream = useJobStream(id);
  const cancelMutation = useCancelJobMutation();
  const [confirmOpen, setConfirmOpen] = useState(false);

  // The stream's snapshot is newer than the query's cached row whenever it
  // exists, so it wins; the query remains the fallback until the first
  // frame lands (and the sole source for a job that has already finished).
  const job: Job | null = stream.job ?? jobQuery.data?.job ?? null;

  /**
   * History from the query, then this connection's frames — de-duplicated
   * by id, because a reconnect can replay a line the query already
   * returned. The stream alone is explicitly *not* the full history.
   */
  const logs = useMemo<readonly JobLogEntry[]>(() => {
    const merged = new Map<string, JobLogEntry>();
    for (const entry of jobQuery.data?.logs ?? []) merged.set(entry.id, entry);
    for (const entry of stream.logs) merged.set(entry.id, entry);
    return [...merged.values()].sort((a, b) => a.loggedAt.localeCompare(b.loggedAt));
  }, [jobQuery.data, stream.logs]);

  const backButton = (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => navigate('/maintenance/jobs')}
      className="w-fit"
    >
      <ArrowLeft className="size-3.5" aria-hidden="true" />
      All jobs
    </Button>
  );

  if (jobQuery.isError && isNotFound(jobQuery.error)) {
    return (
      <div className="flex flex-col gap-6">
        {backButton}
        <EmptyState
          variant="first-run"
          title="Job not found"
          description="No job has this id. It may have been removed, or the link may be out of date."
          action={{ label: 'Back to jobs', onClick: () => navigate('/maintenance/jobs') }}
        />
      </div>
    );
  }

  if (jobQuery.isError) {
    return (
      <div className="flex flex-col gap-6">
        {backButton}
        <ErrorState
          message="Could not load this job."
          errorId={errorIdOf(jobQuery.error)}
          onRetry={() => void jobQuery.refetch()}
        />
      </div>
    );
  }

  if (job === null) {
    return (
      <div className="flex flex-col gap-6">
        {backButton}
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const cancellable = isActiveJobStatus(job.status);
  const backupId = backupIdOf(job.metadata);

  return (
    <div className="flex flex-col gap-6">
      {backButton}

      <PageHeader
        title={JOB_TYPE_LABELS[job.type]}
        description={`Started by ${job.createdByLabel} · ${formatDateTime(job.createdAt)}`}
        action={
          cancellable ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setConfirmOpen(true)}
            >
              Cancel job
            </Button>
          ) : undefined
        }
      />

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3">
          <CardTitle>Progress</CardTitle>
          <StatusBadge status={JOB_STATUS_TONE[job.status]} label={JOB_STATUS_LABELS[job.status]} />
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <JobProgress job={job} size="lg" />

          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-body-sm lg:grid-cols-4">
            <div>
              <dt className="text-text-secondary">Created</dt>
              <dd className="text-text-primary">{formatDateTime(job.createdAt)}</dd>
            </div>
            <div>
              <dt className="text-text-secondary">Started</dt>
              <dd className="text-text-primary">{formatDateTime(job.startedAt)}</dd>
            </div>
            <div>
              <dt className="text-text-secondary">Finished</dt>
              <dd className="text-text-primary">{formatDateTime(job.finishedAt)}</dd>
            </div>
            <div>
              <dt className="text-text-secondary">Job id</dt>
              <dd className="font-mono-sm break-all text-text-primary">{job.id}</dd>
            </div>
            {backupId !== null ? (
              <div>
                <dt className="text-text-secondary">Backup</dt>
                <dd className="font-mono-sm break-all text-text-primary">{backupId}</dd>
              </div>
            ) : null}
          </dl>

          {job.status === 'failed' && job.errorMessage !== null ? (
            <p className="rounded-sm bg-status-critical-bg px-3 py-2 text-body-sm wrap-anywhere text-status-critical-fg">
              {job.errorMessage}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3">
          <CardTitle>Log</CardTitle>
          {/*
            Connection state changes rarely (unlike progress), so a polite
            status here is useful rather than noisy. `connected: false` is
            never reported as a failure: EventSource reconnects on its own,
            and only the *job* can fail.
          */}
          {cancellable ? (
            <span role="status" className="text-caption text-text-secondary">
              {stream.connected ? 'Live' : 'Reconnecting…'}
            </span>
          ) : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <JobLogList entries={logs} />
          <p className="text-caption text-text-muted">
            Lines already written before this page opened are included; new lines arrive as the job
            writes them.
          </p>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        tier={1}
        title="Cancel this job?"
        description={`${JOB_TYPE_LABELS[job.type]} will stop where it is and finish as cancelled. Any work it had already done is not undone.`}
        confirmLabel="Cancel job"
        cancelLabel="Keep running"
        destructive
        pending={cancelMutation.isPending}
        onConfirm={() => {
          cancelMutation.mutate(job.id, {
            onSuccess: () => {
              setConfirmOpen(false);
              toast.success('Job cancelled');
            },
            onError: () => toast.error('Could not cancel this job'),
          });
        }}
      />
    </div>
  );
}
