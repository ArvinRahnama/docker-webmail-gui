/**
 * `/mail/queue` (M11 gap-closing pass — UX_ARCHITECTURE.md §5.2: "a
 * stuck queue is a top-three real incident and `postqueue -j` gives us
 * genuine per-message data, so it earns a page"). **Read-only.**
 * `postqueue -f` (force delivery) and `postsuper` (requeue/hold/release/
 * delete) are real, documented Postfix operations this project has not
 * wired up — a named, reachable gap (that section's own "One addition"
 * note), not something this page pretends to offer. There is no flush,
 * hold, or delete control anywhere below.
 */
import { useMemo, useState } from 'react';
import type { MailQueueEntry, MailQueueName } from '@dwg/shared';
import { Badge } from '@/components/ui/badge';
import { DataTable, type DataTableColumn } from '@/components/data-table';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { Input } from '@/components/ui/input';
import { MetricTile } from '@/components/metric-tile';
import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiClientError, ApiError } from '@/lib/api-client';
import { formatBytes, formatDateTime } from '@/lib/format';
import { useMailQueueQuery } from './use-mail-queries';

const QUEUE_LABELS: Readonly<Record<MailQueueName, string>> = {
  incoming: 'Incoming',
  active: 'Active',
  deferred: 'Deferred',
  hold: 'Hold',
};

/** `deferred`/`hold` are the two queues an admin actually worries about; `incoming`/`active` are normal transient states every message passes through. */
const QUEUE_BADGE_TONE: Readonly<Record<MailQueueName, string>> = {
  incoming: 'bg-status-info-bg text-status-info-fg',
  active: 'bg-status-info-bg text-status-info-fg',
  deferred: 'bg-status-warning-bg text-status-warning-fg',
  hold: 'bg-status-warning-bg text-status-warning-fg',
};

function unixToIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

export function QueuePage() {
  const query = useMailQueueQuery();
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const entries = query.data?.entries ?? [];
    if (!search) return entries;
    const needle = search.toLowerCase();
    return entries.filter((entry) => entry.sender.toLowerCase().includes(needle));
  }, [query.data, search]);

  if (query.isError) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Mail queue" description="Currently queued messages, read-only." />
        <ErrorState
          message="Could not load the mail queue."
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

  if (query.isLoading || !query.data) {
    return <Skeleton className="h-64 w-full" />;
  }

  const { byQueue, unparseableLines } = query.data;

  const columns: DataTableColumn<MailQueueEntry>[] = [
    {
      id: 'queueName',
      header: 'Queue',
      sortValue: (row) => row.queueName,
      cell: (row) => (
        <Badge className={QUEUE_BADGE_TONE[row.queueName]}>{QUEUE_LABELS[row.queueName]}</Badge>
      ),
    },
    { id: 'sender', header: 'Sender', sortValue: (row) => row.sender, cell: (row) => row.sender },
    {
      id: 'recipientCount',
      header: 'Recipients',
      sortValue: (row) => row.recipientCount,
      cell: (row) => row.recipientCount,
    },
    {
      id: 'messageSizeBytes',
      header: 'Size',
      sortValue: (row) => row.messageSizeBytes,
      cell: (row) => formatBytes(row.messageSizeBytes),
    },
    {
      id: 'arrivalTime',
      header: 'Arrived',
      sortValue: (row) => row.arrivalTime,
      cell: (row) => formatDateTime(unixToIso(row.arrivalTime)),
    },
    {
      id: 'queueId',
      header: 'Queue ID',
      cell: (row) => <span className="font-mono-sm text-text-muted">{row.queueId}</span>,
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Mail queue"
        description="Currently queued messages, from postqueue -j — read-only."
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {(['incoming', 'active', 'deferred', 'hold'] as const).map((name) => (
          <MetricTile key={name} label={QUEUE_LABELS[name]} value={byQueue[name] ?? 0} />
        ))}
      </div>

      {unparseableLines > 0 ? (
        <p className="text-body-sm text-status-warning-fg">
          {unparseableLines} queue line{unparseableLines === 1 ? '' : 's'} could not be read and are
          not reflected above.
        </p>
      ) : null}

      <Input
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search by sender…"
        aria-label="Search queue by sender"
        className="max-w-xs"
      />

      <DataTable
        data={filtered}
        columns={columns}
        getRowId={(row) => row.queueId}
        caption="Currently queued mail messages"
        initialSort={{ id: 'arrivalTime', desc: false }}
        emptyState={
          <EmptyState
            variant="first-run"
            title="Nothing queued"
            description="No messages are currently sitting in any Postfix queue."
          />
        }
      />
    </div>
  );
}
