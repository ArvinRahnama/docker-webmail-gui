/**
 * `/maintenance/updates` (M10 — IMPLEMENTATION_PLAN.md §2.2,
 * FEATURE_MATRIX.md §31). Two facts and one refusal:
 *
 *  - What image the container is running now, and what the registry has
 *    for the same tag. Either can be unresolvable, and an unresolvable
 *    one is reported as unknown rather than guessed — the same discipline
 *    DNS state follows (AGENT_BRIEF.md §4: `Unknown` is never `Invalid`).
 *  - Applying an update needs container *recreation*, which the broker
 *    deliberately does not implement, so `POST /updates/apply` refuses.
 *    The page renders that refusal from the server's own response rather
 *    than hard-coding it, so a future broker capability changes one tier
 *    and not this file.
 *
 * `rollbackCaveat` is shown unconditionally, including when no update is
 * available. The plan's wording is that promising a clean rollback would
 * be the most dangerous lie the product could tell, and a caveat that only
 * appears at the moment of action is a caveat an admin plans without.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ExternalLink } from 'lucide-react';
import type { UpdateStatusResponse } from '@dwg/shared';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { ErrorState } from '@/components/error-state';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status/status-badge';
import type { Status } from '@/components/status/status';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiClientError, ApiError } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { useApplyUpdateMutation, useUpdateStatusQuery } from './use-maintenance-queries';

function errorIdOf(error: unknown): string {
  return error instanceof ApiError || error instanceof ApiClientError ? error.errorId : 'unknown';
}

function errorMessageOf(error: unknown, fallback: string): string {
  return error instanceof ApiError || error instanceof ApiClientError ? error.message : fallback;
}

/**
 * Three states, not two. "Up to date" is a positive claim and is only made
 * when both digests resolved and matched; when the registry could not be
 * reached at all, the honest answer is that we do not know, which is grey
 * `unknown` — never a green "up to date" inferred from a failed lookup.
 */
function updateStatusOf(status: UpdateStatusResponse): { tone: Status; label: string } {
  if (status.available === null) return { tone: 'unknown', label: 'Could not check' };
  if (status.updateAvailable) return { tone: 'warning', label: 'Update available' };
  return { tone: 'healthy', label: 'Up to date' };
}

/** A digest is long and unwrappable; `null` renders as prose, never as an empty cell. */
function DigestValue({ digest }: { readonly digest: string | null }) {
  if (digest === null) {
    return <span className="text-text-muted">Could not be resolved</span>;
  }
  return <span className="font-mono-sm break-all">{digest}</span>;
}

export function UpdatesPage() {
  const statusQuery = useUpdateStatusQuery();
  const applyMutation = useApplyUpdateMutation();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const status = statusQuery.data;

  const confirmApply = () => {
    applyMutation.mutate(undefined, {
      // Deliberately no `onSuccess`: this call is expected to fail, and a
      // success path here would be a claim the product cannot honour.
      onError: (error) => {
        setConfirmOpen(false);
        toast.error(errorMessageOf(error, 'Applying an update is not supported from the panel.'));
      },
    });
  };

  if (statusQuery.isError) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Updates" description="The running image, compared with the registry." />
        <ErrorState
          message="Could not load update status."
          errorId={errorIdOf(statusQuery.error)}
          onRetry={() => void statusQuery.refetch()}
        />
      </div>
    );
  }

  if (status === undefined) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Updates" description="The running image, compared with the registry." />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const { tone, label } = updateStatusOf(status);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Updates"
        description="The running image, compared with the registry."
        action={
          <Button type="button" variant="secondary" onClick={() => setConfirmOpen(true)}>
            Apply update
          </Button>
        }
      />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <CardTitle>docker-mailserver</CardTitle>
          <StatusBadge status={tone} label={label} />
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-body-sm">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <dt className="text-text-muted">Running now</dt>
              <dd>
                <DigestValue digest={status.current.digest} />
              </dd>
            </div>

            <div className="flex flex-col gap-1">
              <dt className="text-text-muted">Available in registry</dt>
              <dd>
                <DigestValue digest={status.available?.digest ?? null} />
              </dd>
            </div>

            <div className="flex flex-col gap-1">
              <dt className="text-text-muted">Tags</dt>
              <dd>
                {status.current.repoTags.length === 0 ? (
                  <span className="text-text-muted">None recorded</span>
                ) : (
                  <span className="font-mono-sm break-all">
                    {status.current.repoTags.join(', ')}
                  </span>
                )}
              </dd>
            </div>

            <div className="flex flex-col gap-1">
              <dt className="text-text-muted">Last checked</dt>
              <dd>{formatDateTime(status.checkedAt)}</dd>
            </div>
          </dl>

          {status.available === null ? (
            <p className="text-text-secondary">
              The registry could not be reached, so whether a newer image exists is unknown. This is
              not a claim that the running image is current.
            </p>
          ) : null}

          <p>
            <a
              href={status.releaseNotesUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 underline underline-offset-2"
            >
              Release notes
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Before you update</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-body-sm">
          <p className="text-text-primary">{status.rollbackCaveat}</p>

          {status.recentVerifiedBackupExists ? (
            <p className="text-status-healthy-fg">
              A verified backup exists, taken {formatDateTime(status.mostRecentVerifiedBackupAt)}.
            </p>
          ) : (
            <p className="text-status-warning-fg">
              No recent verified backup is on record.{' '}
              <Link to="/maintenance/backups" className="underline underline-offset-2">
                Take one first
              </Link>
              .
            </p>
          )}
        </CardContent>
      </Card>

      {/*
        Tier 3 rather than 4: the request is refused server-side, so nothing
        destructive can follow from confirming. The typed confirmation is
        still here because the *intent* is a container recreation, and an
        admin should meet the same friction whether or not today's broker
        happens to refuse it.
      */}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        tier={3}
        title="Apply update"
        confirmLabel="Apply update"
        resourceName="docker-mailserver"
        pending={applyMutation.isPending}
        onConfirm={confirmApply}
        description="Replace the running docker-mailserver image with the one in the registry."
        impactSummary={
          <span>
            Updating means recreating the container. The broker cannot create or remove containers,
            so this will be refused — it is shown here so the panel reports what it cannot do rather
            than hiding the action.
          </span>
        }
      />
    </div>
  );
}
