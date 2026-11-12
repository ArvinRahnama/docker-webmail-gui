import { useMemo, useState } from 'react';
import { MailCheck } from 'lucide-react';
import { REJECTION_CATEGORIES, type RejectedMailEntry, type RejectionCategory } from '@dwg/shared';
import { BreakableText } from '@/components/breakable-text';
import { DataTable, type DataTableColumn } from '@/components/data-table';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiClientError, ApiError } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import { SpamIntegrationNotice } from './spam-integration-notice';
import { useRejectedMailQuery, useSpamIntegrationQuery } from './use-security-queries';

export const CATEGORY_LABELS: Record<RejectionCategory, string> = {
  spam: 'Spam',
  virus: 'Virus',
  recipient: 'Unknown recipient',
  sender: 'Bad sender',
  client: 'Blocked server',
  policy: 'Policy',
  other: 'Other',
};

const CATEGORY_CLASS: Partial<Record<RejectionCategory, string>> = {
  virus: 'bg-status-critical-bg text-status-critical-fg',
  spam: 'bg-status-warning-bg text-status-warning-fg',
};

export const rejectedMailColumns: DataTableColumn<RejectedMailEntry>[] = [
  {
    id: 'at',
    header: 'When',
    cell: (e) => <span className="whitespace-nowrap">{formatDateTime(e.at)}</span>,
    sortValue: (e) => e.at,
  },
  {
    id: 'category',
    header: 'Why',
    cell: (e) => (
      <span className="flex flex-col items-start gap-1">
        <Badge variant="neutral" className={cn(CATEGORY_CLASS[e.category])}>
          {CATEGORY_LABELS[e.category]}
        </Badge>
        {e.temporary ? (
          <span className="text-caption text-text-muted">Temporary — sender will retry</span>
        ) : null}
      </span>
    ),
    sortValue: (e) => e.category,
  },
  {
    id: 'from',
    header: 'From',
    cell: (e) => (
      <span className="flex flex-col">
        <span className="break-words">{e.from ? <BreakableText text={e.from} /> : '—'}</span>
        <span className="font-mono-sm text-caption text-text-muted">
          {[e.clientHost, e.clientIp].filter(Boolean).join(' ') || '—'}
        </span>
      </span>
    ),
    sortValue: (e) => e.from ?? '',
  },
  {
    id: 'to',
    header: 'To',
    cell: (e) => (
      <span className="flex flex-col">
        {e.to.length === 0 ? '—' : e.to.map((r) => <BreakableText key={r} text={r} />)}
      </span>
    ),
  },
  {
    id: 'reason',
    header: 'Reason',
    cell: (e) => (
      <span className="flex flex-col gap-0.5">
        {e.subject ? <span className="break-words font-medium">{e.subject}</span> : null}
        <span className="break-words text-text-secondary">{e.reason}</span>
        <span className="font-mono-sm text-caption text-text-muted">
          {[e.smtpCode, e.score === null ? null : `score ${e.score.toFixed(2)}`]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </span>
    ),
  },
];

/**
 * `/security/rejected-mail` — what the mail server refused at SMTP time,
 * and why: Postfix's own refusals plus Rspamd's verdicts (spam, viruses),
 * with the subject where Rspamd recorded it.
 */
export function RejectedMailPage() {
  const query = useRejectedMailQuery();
  const integration = useSpamIntegrationQuery();
  const [category, setCategory] = useState<RejectionCategory | 'all'>('all');

  const entries = useMemo(
    () => (query.data?.entries ?? []).filter((e) => category === 'all' || e.category === category),
    [query.data, category],
  );

  const header = (
    <PageHeader
      title="Rejected Mail"
      description="Messages this server refused when they arrived, and why. The sender is told; the recipient never sees them."
    />
  );

  if (query.isError) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <ErrorState
          message="Could not load rejected mail."
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
    return <Skeleton className="h-96 w-full" />;
  }

  const counts = new Map<RejectionCategory, number>();
  for (const e of query.data.entries) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);

  return (
    <div className="flex flex-col gap-6">
      {header}
      <SpamIntegrationNotice integration={integration.data} />

      {!query.data.logAvailable ? (
        <p className="text-body-sm text-status-warning-fg">
          The mail log could not be read{query.data.logError ? `: ${query.data.logError}` : '.'}
        </p>
      ) : null}

      <Card>
        <CardHeader className="gap-3">
          <CardTitle className="text-body font-semibold">
            {query.data.entries.length} rejected
          </CardTitle>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by reason">
            {(['all', ...REJECTION_CATEGORIES] as const)
              .filter((c) => c === 'all' || counts.has(c))
              .map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-pressed={category === c}
                  onClick={() => setCategory(c)}
                  className={cn(
                    'rounded-full border px-3 py-1 text-caption transition-colors duration-fast',
                    category === c
                      ? 'border-accent bg-accent-subtle-bg text-accent'
                      : 'border-border-default text-text-secondary hover:bg-bg-inset',
                  )}
                >
                  {c === 'all' ? 'All' : CATEGORY_LABELS[c]}
                  {c === 'all' ? '' : ` (${counts.get(c) ?? 0})`}
                </button>
              ))}
          </div>
          <p className="text-caption text-text-muted">Covers {query.data.window}.</p>
        </CardHeader>
        <CardContent>
          <DataTable
            data={entries}
            columns={rejectedMailColumns}
            getRowId={(e) => `${e.at}|${e.source}|${e.from ?? ''}|${e.to.join(',')}|${e.reason}`}
            caption="Rejected mail"
            initialSort={{ id: 'at', desc: true }}
            pageSize={25}
            emptyState={
              category === 'all' ? (
                <EmptyState
                  variant="first-run"
                  icon={MailCheck}
                  title="Nothing rejected"
                  description="No message was refused in the part of the log that is still available."
                />
              ) : (
                <EmptyState
                  variant="filtered"
                  activeFilters={[CATEGORY_LABELS[category]]}
                  onClearFilters={() => setCategory('all')}
                />
              )
            }
          />
        </CardContent>
      </Card>
    </div>
  );
}
