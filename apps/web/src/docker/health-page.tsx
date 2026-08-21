import { Card, CardContent } from '@/components/ui/card';
import { ErrorState } from '@/components/error-state';
import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/status/status-badge';
import { ApiClientError, ApiError } from '@/lib/api-client';
import { useHealthChecksQuery } from './use-docker-queries';

/**
 * `/docker/health` (M9 — FEATURE_MATRIX.md §30). Each check card renders
 * exactly what `HealthService` computed for it, independently, including
 * its own `checkedAt` — this page never infers or displays a combined
 * "overall" state that isn't itself one of the checks, so a partial
 * outage is always visible as exactly which check is affected:
 * "Nothing is inferred from another check's result."
 */
export function HealthPage() {
  const query = useHealthChecksQuery();

  if (query.isError) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Health centre" description="Independent status per subsystem." />
        <ErrorState
          message="Could not load health checks."
          errorId={
            query.error instanceof ApiError || query.error instanceof ApiClientError
              ? query.error.errorId
              : 'unknown'
          }
          onRetry={() => void query.refetch()}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Health centre"
        description="Each check below is observed and reported independently — one failing check never implies another's state."
      />

      {query.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {(query.data ?? []).map((check) => (
            <Card key={check.id}>
              <CardContent className="flex flex-col gap-2 pt-6">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-body-sm font-semibold text-text-primary">
                    {check.label}
                  </span>
                  <StatusBadge status={check.state} />
                </div>
                {check.message ? (
                  <p className="text-body-sm text-text-secondary">{check.message}</p>
                ) : null}
                <p className="text-caption text-text-muted">
                  Checked {new Date(check.checkedAt).toLocaleTimeString()}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
