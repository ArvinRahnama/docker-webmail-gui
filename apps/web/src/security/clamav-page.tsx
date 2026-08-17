import { useState } from 'react';
import { RefreshCw, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { ErrorState } from '@/components/error-state';
import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/status/status-badge';
import { UnsupportedNotice } from '@/components/unsupported-notice';
import { ApiClientError, ApiError } from '@/lib/api-client';
import {
  useClamavDetectionsQuery,
  useClamavStatusQuery,
  useTriggerClamavUpdateMutation,
} from './use-security-queries';

/**
 * `/security/clamav` (FEATURE_MATRIX.md §16). Status (`PING`/`VERSION`)
 * and raw `STATS` are read live; detections are explicitly log-derived,
 * labelled with the sampling window every time they are shown — never a
 * bare number that could be mistaken for a lifetime total.
 */
export function ClamavPage() {
  const statusQuery = useClamavStatusQuery();
  const detectionsQuery = useClamavDetectionsQuery();
  const updateMutation = useTriggerClamavUpdateMutation();
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (statusQuery.isError) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="ClamAV" description="Antivirus daemon status and signatures." />
        <ErrorState
          message="Could not load ClamAV status."
          errorId={
            statusQuery.error instanceof ApiError || statusQuery.error instanceof ApiClientError
              ? statusQuery.error.errorId
              : 'unknown'
          }
          onRetry={() => void statusQuery.refetch()}
        />
      </div>
    );
  }

  if (statusQuery.isLoading || !statusQuery.data) {
    return <Skeleton className="h-64 w-full" />;
  }

  const status = statusQuery.data;

  if (!status.capability.supported) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="ClamAV" description="Antivirus daemon status and signatures." />
        <UnsupportedNotice
          reason={status.capability.reason ?? 'ClamAV is unsupported on this deployment.'}
          docsHref="https://docker-mailserver.github.io/docker-mailserver/latest/config/security/antivirus/"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="ClamAV"
        description="Antivirus daemon status and signature database, checked live over the clamd control socket."
        action={
          <Button type="button" variant="secondary" onClick={() => setConfirmOpen(true)}>
            <RefreshCw className="size-3.5" aria-hidden="true" />
            Update signatures
          </Button>
        }
      />

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-body font-semibold">Daemon</CardTitle>
          <StatusBadge status={status.reachable ? 'healthy' : 'critical'} />
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-body-sm">
          {!status.reachable ? (
            <p className="text-text-muted">
              {status.error ?? 'clamd is not reachable over its control socket.'}
            </p>
          ) : (
            <div className="flex items-start justify-between gap-3">
              <span className="shrink-0 text-text-muted">Version</span>
              <span className="text-right font-mono-sm text-text-primary">
                {status.version ?? 'Unknown — reply did not match the expected format.'}
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {status.reachable && status.stats ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-body font-semibold">Daemon stats (raw)</CardTitle>
            <p className="text-caption text-text-muted">
              <code className="font-mono-sm">STATS</code> is documented upstream as unstable free
              text, not a fixed schema — shown verbatim rather than parsed.
            </p>
          </CardHeader>
          <CardContent>
            <pre className="max-h-64 overflow-auto rounded-sm bg-bg-inset p-3 font-mono-sm text-text-secondary">
              {status.stats}
            </pre>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="flex-row items-center gap-2 space-y-0">
          <ShieldAlert className="size-4 text-text-muted" aria-hidden="true" />
          <CardTitle className="text-body font-semibold">Detections (log-derived)</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-body-sm">
          {detectionsQuery.isLoading || !detectionsQuery.data ? (
            <Skeleton className="h-10 w-full" />
          ) : !detectionsQuery.data.available ? (
            <p className="text-text-muted">
              {detectionsQuery.data.reason ?? 'Detection count is currently unavailable.'}
            </p>
          ) : (
            <>
              <p className="text-h2 font-semibold text-text-primary">
                {detectionsQuery.data.count}
              </p>
              <p className="text-caption text-text-muted">
                clamd exposes no detection counter — this is parsed from the mail log, not a live
                statistic. {detectionsQuery.data.windowDescription}
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        tier={2}
        title="Trigger a signature update?"
        description="Runs freshclam now to fetch the latest ClamAV signature database. This can take a moment and should not be run excessively often."
        confirmLabel="Update now"
        pending={updateMutation.isPending}
        onConfirm={() => {
          updateMutation.mutate(undefined, { onSuccess: () => setConfirmOpen(false) });
        }}
      />
    </div>
  );
}
