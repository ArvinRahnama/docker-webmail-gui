import { DataTable, type DataTableColumn } from '@/components/data-table';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiClientError, ApiError } from '@/lib/api-client';
import type { NetworkSummary } from '@dwg/shared';
import { useNetworksQuery } from './use-docker-queries';

/** `/docker/networks` (M9 — FEATURE_MATRIX.md §24). Read-only (AGENT_BRIEF.md §4) — no action column, no mutation anywhere on this page. */
export function NetworksPage() {
  const query = useNetworksQuery();

  const columns: DataTableColumn<NetworkSummary>[] = [
    { id: 'name', header: 'Name', sortValue: (row) => row.name, cell: (row) => row.name },
    { id: 'driver', header: 'Driver', sortValue: (row) => row.driver, cell: (row) => row.driver },
    { id: 'scope', header: 'Scope', sortValue: (row) => row.scope, cell: (row) => row.scope },
    {
      id: 'id',
      header: 'Network ID',
      cell: (row) => (
        <span className="font-mono-sm text-text-secondary">{row.id.slice(0, 12)}</span>
      ),
    },
  ];

  if (query.isError) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Networks" description="Every Docker network on this host. Read-only." />
        <ErrorState
          message="Could not load the network list."
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
      <PageHeader title="Networks" description="Every Docker network on this host. Read-only." />
      {query.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <DataTable
          data={query.data ?? []}
          columns={columns}
          getRowId={(row) => row.id}
          caption="Every Docker network on this host"
          emptyState={
            <EmptyState
              variant="first-run"
              title="No networks"
              description="No networks exist yet."
            />
          }
        />
      )}
    </div>
  );
}
