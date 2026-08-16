import { useNavigate } from 'react-router-dom';
import type { QuotaReportEntry } from '@dwg/shared';
import { DataTable, type DataTableColumn } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { UnsupportedNotice } from '@/components/unsupported-notice';
import { ApiClientError, ApiError } from '@/lib/api-client';
import { formatBytes, formatPercent, formatQuota } from '@/lib/format';
import { useMailCapabilitiesQuery, useQuotaReportQuery } from './use-mail-queries';

const WARN_THRESHOLD = 0.8;
const CRITICAL_THRESHOLD = 0.9;

function UsageBadge({ entry }: { entry: QuotaReportEntry }) {
  if (entry.percentUsed === null) {
    return <Badge variant="neutral">Unknown</Badge>;
  }
  if (entry.percentUsed >= CRITICAL_THRESHOLD) {
    return (
      <Badge className="bg-status-critical-bg text-status-critical-fg">
        {formatPercent(entry.percentUsed)}
      </Badge>
    );
  }
  if (entry.percentUsed >= WARN_THRESHOLD) {
    return (
      <Badge className="bg-status-warning-bg text-status-warning-fg">
        {formatPercent(entry.percentUsed)}
      </Badge>
    );
  }
  return <Badge variant="neutral">{formatPercent(entry.percentUsed)}</Badge>;
}

/**
 * `/mail/storage` — a usage report, not a CRUD page
 * (UX_ARCHITECTURE.md §5.1 row 5). Editing a quota happens on the
 * mailbox this page links to; this page never mutates anything.
 */
export function StoragePage() {
  const navigate = useNavigate();
  const capabilities = useMailCapabilitiesQuery();
  const query = useQuotaReportQuery(capabilities.data?.quotas.supported ?? false);

  const columns: DataTableColumn<QuotaReportEntry>[] = [
    {
      id: 'email',
      header: 'Mailbox',
      sortValue: (row) => row.email,
      cell: (row) => (
        <button
          type="button"
          onClick={() => navigate(`/mail/mailboxes/${encodeURIComponent(row.email)}`)}
          className="font-medium text-accent hover:underline"
        >
          {row.email}
        </button>
      ),
    },
    { id: 'domain', header: 'Domain', sortValue: (row) => row.domain, cell: (row) => row.domain },
    {
      id: 'quota',
      header: 'Limit',
      sortValue: (row) => row.quota ?? '',
      cell: (row) => formatQuota(row.quota),
    },
    {
      id: 'used',
      header: 'Used',
      sortValue: (row) => row.usage?.storageBytesUsed ?? -1,
      cell: (row) => formatBytes(row.usage?.storageBytesUsed ?? null),
    },
    {
      id: 'percentUsed',
      header: 'Usage',
      sortValue: (row) => row.percentUsed ?? -1,
      cell: (row) => <UsageBadge entry={row} />,
    },
  ];

  if (capabilities.isLoading) {
    return <Skeleton className="h-64 w-full" />;
  }

  if (capabilities.data && !capabilities.data.quotas.supported) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Storage"
          description="Mailbox quota usage, sorted by who is nearest their limit."
        />
        <UnsupportedNotice
          reason={
            capabilities.data.quotas.reason ??
            'Quotas are unsupported on this deployment. Set ENABLE_QUOTAS=1 on the mail server to enable them.'
          }
          docsHref="https://docker-mailserver.github.io/docker-mailserver/latest/config/account-management/overview/#quotas"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Storage"
        description="Mailbox quota usage, sorted by who is nearest their limit. Set or clear a quota from the mailbox itself."
      />

      {query.isError ? (
        <ErrorState
          message="Could not load the storage report."
          errorId={
            query.error instanceof ApiError || query.error instanceof ApiClientError
              ? query.error.errorId
              : 'unknown'
          }
          onRetry={() => void query.refetch()}
        />
      ) : query.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <DataTable
          data={query.data?.entries ?? []}
          columns={columns}
          getRowId={(row) => row.email}
          caption="Mailbox storage usage"
          initialSort={{ id: 'percentUsed', desc: true }}
          emptyState={
            <EmptyState
              variant="first-run"
              title="No quotas configured"
              description="Set a quota on a mailbox to see its usage tracked here."
            />
          }
        />
      )}
    </div>
  );
}
