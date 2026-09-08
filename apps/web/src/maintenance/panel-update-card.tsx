/**
 * The "Panel" card on `/maintenance/updates` (docs/design/self-update.md
 * — SU-D), a completely separate concern from the existing
 * docker-mailserver card `updates-page.tsx` still renders unchanged
 * (owner §9.3): different service (`PanelSelfUpdateService`, not
 * `UpdatesService`), different version source
 * (`SelfUpdateReleaseSourcePort`, auto-latest — §9.1, the admin only
 * confirms), different mutation (a real container recreate, not an
 * always-refused one).
 *
 * Two phases, reusing two existing mechanisms rather than inventing a
 * third (design §6):
 *
 *  - **Phase A ("prepare")** — `POST /api/v1/updates/panel/apply`
 *    enqueues a `panel.selfUpdate` job; its progress streams over the
 *    same `useJobStream`/`JobProgress` machinery `backups-page.tsx`
 *    already uses for create/verify/restore. The job reaching
 *    `succeeded` here means the point of no return was reached — the
 *    broker accepted the recreate and launched the updater — not that
 *    the recreate itself succeeded; see `updater.ts` (broker) and this
 *    file's own header on why the verdict is never the job's status.
 *  - **Phase B ("recreate")** — reuses `server-controls.tsx`'s
 *    `doRestartPanel` reconnect shape (blocking overlay, bounded poll of
 *    `/api/v1/health`), extended per the owner-approved design: the poll
 *    must see the target version specifically, not just any 2xx, because
 *    a health-only check cannot tell "the new version came up" from "a
 *    rollback silently restored the old one and it is healthy too."
 *    Once the panel answers at all (target version, or a different one —
 *    e.g. a completed rollback), this stops polling and defers to the
 *    real verdict: `GET /api/v1/updates/panel/last-result`, the durable
 *    status file the updater itself wrote (§4). A version match alone is
 *    never treated as success on its own; the status file always has the
 *    final word, exactly per §6's "the verdict comes from the status
 *    file, not health."
 *
 * Tier 4 (owner-approved §7, extending UX_ARCHITECTURE.md §8's standard
 * tiers): type-to-confirm plus the same backup-status gate restore uses
 * (`ConfirmDialogBackupStatus`) — reusing the *same*
 * `recentVerifiedBackupExists`/`mostRecentVerifiedBackupAt` fact
 * `useUpdateStatusQuery` already loads for the docker-mailserver card
 * (`UpdateStatusResponseSchema`'s own "one recent-verified-backup concept
 * for the whole product, not two"), not a second copy of it. The honest
 * reason for the gate is not "this touches mail data" (it does not) but
 * "if this goes wrong and you need to intervene by hand, you will want
 * everything else in a known-good state" (design §7).
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import type { Job, SelfUpdateResult } from '@dwg/shared';
import { isActiveJobStatus } from '@dwg/shared';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { StatusBadge } from '@/components/status/status-badge';
import type { Status } from '@/components/status/status';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiClientError, ApiError } from '@/lib/api-client';
import { probePanelVersion } from '@/lib/docker-api';
import { fetchPanelSelfUpdateLastResult } from '@/lib/maintenance-api';
import { formatDateTime } from '@/lib/format';
import { JobProgress } from './jobs-page';
import {
  useApplyPanelUpdateMutation,
  useJobQuery,
  useJobStream,
  usePanelUpdateStatusQuery,
  useUpdateStatusQuery,
} from './use-maintenance-queries';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Same beat `server-controls.tsx`'s `doRestartPanel` waits before its first probe — in production, lets the old process actually start going down before the first health check (otherwise a probe issued while it is still up would count as "already back"). In development (fake broker) nothing ever goes down, so this is just a brief pause. */
const GO_DOWN_GRACE_MS = 2_000;
const POLL_INTERVAL_MS = 1_500;
/** Matches `server-controls.tsx`'s own `RECONNECT_TIMEOUT_MS` and `updater.ts`'s `HEALTH_POLL_TIMEOUT_MS` — one number for "how long do we wait for the panel to come back", not several that could drift (docs/design/self-update.md §4). */
const RECONNECT_TIMEOUT_MS = 90_000;

function errorMessageOf(error: unknown, fallback: string): string {
  return error instanceof ApiError || error instanceof ApiClientError ? error.message : fallback;
}

/**
 * Three states, mirroring `updates-page.tsx`'s own `updateStatusOf` — but
 * worded distinctly ("Newer release published" / "Running latest" /
 * "Version unknown" rather than "Update available" / "Up to date" /
 * "Could not check") so the two cards' status text never collides on the
 * same page, for a human reader and for `e2e/update.spec.ts`'s existing
 * locators alike.
 */
function panelStatusOf(status: {
  readonly updatePossible: boolean;
  readonly updateAvailable: boolean;
}): { tone: Status; label: string } {
  if (!status.updatePossible) return { tone: 'unknown', label: 'Version unknown' };
  if (status.updateAvailable) return { tone: 'warning', label: 'Newer release published' };
  return { tone: 'healthy', label: 'Running latest' };
}

export type PanelReconnectOutcome = 'target' | 'other' | 'timeout';

export interface WaitForPanelReconnectOptions {
  readonly targetVersion: string;
  /** `probePanelVersion` in production; a scripted stub in tests — never a real 90-second wait. */
  readonly probeVersion: () => Promise<string | null>;
  readonly delay: (ms: number) => Promise<void>;
  readonly deadlineMs: number;
  readonly intervalMs: number;
  /** Injectable clock, mirroring `updater.test.ts`'s (apps/broker) own fake-clock pattern — defaults to the real one. */
  readonly now?: () => number;
}

/**
 * The bounded reconnect poll, factored out of the component so it is
 * directly unit-testable with a fake `delay`/`probeVersion` — no real
 * waiting, exactly like the broker-side updater's own dependency-injected
 * health poll (`apps/broker/src/self-update/updater.ts`).
 *
 * Returns as soon as the panel answers *at all* — `'target'` when it
 * reports the version this apply targeted, `'other'` when it answers with
 * a different one (most plausibly a completed rollback, healthy on the
 * old version). Neither is treated as success by itself: the caller
 * always defers to `GET /api/v1/updates/panel/last-result` for the real
 * verdict (see this file's header). Returning immediately on `'other'`
 * rather than continuing to poll for the target specifically avoids
 * blocking an admin for the full timeout in the (deterministic) rollback
 * case, where the target version was never going to appear.
 */
export async function waitForPanelReconnect(
  options: WaitForPanelReconnectOptions,
): Promise<PanelReconnectOutcome> {
  const now = options.now ?? Date.now;
  const deadline = now() + options.deadlineMs;
  for (;;) {
    const version = await options.probeVersion();
    if (version === options.targetVersion) return 'target';
    if (version !== null) return 'other';
    if (now() >= deadline) return 'timeout';
    await options.delay(options.intervalMs);
  }
}

function describeResult(
  result: SelfUpdateResult | null,
  target: string,
): {
  readonly tone: 'success' | 'error' | 'warning';
  readonly message: string;
} {
  if (result === null) {
    return {
      tone: 'warning',
      message: `The panel reconnected, but no self-update result was recorded (was targeting ${target}).`,
    };
  }
  if (result.outcome === 'success') {
    return { tone: 'success', message: `Panel updated to ${result.toVersion}.` };
  }
  if (result.outcome === 'rolled-back') {
    return {
      tone: 'error',
      message:
        `Update to ${result.toVersion} failed and was rolled back to ${result.fromVersion ?? 'the previous version'}.` +
        (result.reason === null ? '' : ` ${result.reason}`),
    };
  }
  return {
    tone: 'error',
    message:
      `Update to ${result.toVersion} failed before either container was touched.` +
      (result.reason === null ? '' : ` ${result.reason}`),
  };
}

export function PanelUpdateCard() {
  const navigate = useNavigate();
  const statusQuery = usePanelUpdateStatusQuery();
  // Same query the docker-mailserver card already runs — this is the "one
  // recent-verified-backup concept for the whole product" fact, read a
  // second time here rather than duplicated (React Query dedupes an
  // identical key, so this costs nothing extra on the wire).
  const dmsStatusQuery = useUpdateStatusQuery();
  const applyMutation = useApplyPanelUpdateMutation();

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [activeJobId, setActiveJobId] = useState('');
  const [reconnecting, setReconnecting] = useState(false);
  const [appliedTarget, setAppliedTarget] = useState<string | null>(null);
  const handledJobId = useRef<string | null>(null);

  const jobStream = useJobStream(activeJobId);
  const jobQuery = useJobQuery(activeJobId);
  const runningJob: Job | null = jobStream.job ?? jobQuery.data?.job ?? null;

  const status = statusQuery.data;
  const targetVersion = status?.latestVersion ?? null;
  const canApply =
    status !== undefined &&
    status.updatePossible &&
    status.updateAvailable &&
    targetVersion !== null;

  const confirmApply = () => {
    applyMutation.mutate(undefined, {
      onSuccess: (jobId) => {
        setConfirmOpen(false);
        setAppliedTarget(targetVersion);
        setActiveJobId(jobId);
      },
      onError: (error) => {
        setConfirmOpen(false);
        toast.error(errorMessageOf(error, 'Could not start the panel update.'));
      },
    });
  };

  // Reacts to the job reaching a terminal state — the same "a finished job
  // is the only honest trigger" idiom `backups-page.tsx` uses for its own
  // running-job effect. `handledJobId` guards against acting on the same
  // terminal snapshot twice (a re-render, or React 18 dev-mode's double
  // effect invocation).
  useEffect(() => {
    if (runningJob === null) return;
    if (isActiveJobStatus(runningJob.status)) return;
    if (handledJobId.current === runningJob.id) return;
    handledJobId.current = runningJob.id;

    if (runningJob.status !== 'succeeded') {
      setActiveJobId('');
      toast.error(runningJob.errorMessage ?? 'The panel update job failed.');
      return;
    }

    // The point of no return was reached: the broker accepted the
    // recreate and launched the updater. Phase B — see this file's
    // header.
    const target = appliedTarget;
    if (target === null) {
      // Unreachable in practice (appliedTarget is set in the same
      // click handler that starts this job) — defensive, not a silent
      // skip.
      setActiveJobId('');
      toast.error('Lost track of which version this update was targeting.');
      return;
    }

    setReconnecting(true);
    void (async () => {
      await delay(GO_DOWN_GRACE_MS);
      const outcome = await waitForPanelReconnect({
        targetVersion: target,
        probeVersion: probePanelVersion,
        delay,
        deadlineMs: RECONNECT_TIMEOUT_MS,
        intervalMs: POLL_INTERVAL_MS,
      });

      setReconnecting(false);
      setActiveJobId('');

      if (outcome === 'timeout') {
        toast.error('The panel did not respond within 90 seconds. Reload the page to check on it.');
        void statusQuery.refetch();
        return;
      }

      const result = await fetchPanelSelfUpdateLastResult().catch(() => null);
      void statusQuery.refetch();
      const { tone, message } = describeResult(result, target);
      if (tone === 'success') toast.success(message);
      else if (tone === 'warning') toast.warning(message);
      else toast.error(message);
    })();
    // `statusQuery` is intentionally not a dependency — it is a new object
    // every render (same reasoning `backups-page.tsx`'s own effect comment
    // gives for `backupsQuery`), and `.refetch` is stable across renders;
    // `runningJob`/`appliedTarget` are the real dependencies. No disable
    // directive here: eslint-plugin-react-hooks is not in this project's
    // tooling budget, and naming a rule that is not installed is itself a
    // lint error (see `backups-page.tsx`'s identical note).
  }, [runningJob, appliedTarget]);

  if (statusQuery.isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Panel</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-status-critical-fg">Could not load the panel's update status.</p>
        </CardContent>
      </Card>
    );
  }

  if (status === undefined) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Panel</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    );
  }

  const { tone, label } = panelStatusOf(status);

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <CardTitle>Panel</CardTitle>
          <StatusBadge status={tone} label={label} />
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-body-sm">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <dt className="text-text-muted">Running now</dt>
              <dd>{status.currentVersion ?? 'Could not be resolved'}</dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-text-muted">Latest published</dt>
              <dd>{status.latestVersion ?? 'Could not be resolved'}</dd>
            </div>
          </dl>

          {!status.updatePossible && status.reason !== null ? (
            <p className="text-text-secondary">{status.reason}</p>
          ) : null}

          {runningJob !== null ? (
            <div className="flex flex-col gap-3 rounded-md border border-border-default bg-bg-inset p-3">
              <JobProgress job={runningJob} size="lg" />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => navigate(`/maintenance/jobs/${encodeURIComponent(runningJob.id)}`)}
              >
                View job log
              </Button>
            </div>
          ) : null}

          <div>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setConfirmOpen(true)}
              disabled={!canApply || applyMutation.isPending || activeJobId !== '' || reconnecting}
            >
              Apply panel update
            </Button>
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        tier={4}
        destructive
        title="Apply panel update"
        description="Recreates both of the panel's own containers on the newer version. You will be disconnected while this happens; this page reconnects automatically and reports the real outcome once it does."
        confirmLabel="Apply panel update"
        pending={applyMutation.isPending}
        onConfirm={confirmApply}
        impactSummary={
          targetVersion === null ? null : (
            <span>
              Updates the panel from {status.currentVersion ?? 'an unknown version'} to{' '}
              {targetVersion}. If a health check fails afterward, an automatic rollback is
              attempted; either way both containers are recreated and briefly unavailable.
            </span>
          )
        }
        backup={{
          verified: dmsStatusQuery.data?.recentVerifiedBackupExists ?? false,
          description:
            dmsStatusQuery.data === undefined
              ? 'Backup status unknown — still loading.'
              : dmsStatusQuery.data.recentVerifiedBackupExists
                ? `A recent verified backup exists, taken ${formatDateTime(dmsStatusQuery.data.mostRecentVerifiedBackupAt)}.`
                : 'No recent verified backup is on record. If this update goes wrong and you need to intervene by hand, you will want everything else in a known-good state first.',
        }}
        resourceName={targetVersion ?? ''}
      />

      {reconnecting ? (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="panel-update-reconnect-title"
          aria-describedby="panel-update-reconnect-desc"
          className="fixed inset-0 z-50 flex items-center justify-center bg-bg-overlay p-4"
        >
          <div className="flex max-w-sm flex-col items-center gap-3 rounded-lg border border-border-default bg-bg-surface p-8 text-center shadow-md">
            <Loader2 className="size-8 animate-spin text-accent" aria-hidden="true" />
            <h2
              id="panel-update-reconnect-title"
              className="text-h2 font-semibold text-text-primary"
            >
              Recreating the panel
            </h2>
            <p
              id="panel-update-reconnect-desc"
              className="text-body-sm text-text-secondary"
              aria-live="polite"
            >
              The panel is briefly unavailable while its containers are recreated. This page
              reconnects automatically and will report the real outcome once it does.
            </p>
          </div>
        </div>
      ) : null}
    </>
  );
}
