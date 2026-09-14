import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import type { AliasSummary, MailboxSummary } from '@dwg/shared';
import { DataTable, type DataTableColumn } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiClientError, ApiError } from '@/lib/api-client';
import { formatQuota } from '@/lib/format';
import { AddressText, AliasDestinationsList, addressFloorClassName } from './address-text';
import { useDomainDetailQuery } from './use-mail-queries';

const MAILBOX_COLUMNS: DataTableColumn<MailboxSummary>[] = [
  {
    id: 'email',
    header: 'Address',
    sortValue: (row) => row.email,
    // AddressText wraps a long address at `@ . _ -` instead of letting it
    // size the column (and the table); short ones stay whole and unfloored.
    cellClassName: 'break-words',
    cell: (row) => (
      <div className={addressFloorClassName(row.email)}>
        <AddressText text={row.email} />
      </div>
    ),
  },
  {
    id: 'quota',
    header: 'Quota',
    sortValue: (row) => row.quota ?? '',
    cell: (row) => formatQuota(row.quota),
  },
];

const ALIAS_COLUMNS: DataTableColumn<AliasSummary>[] = [
  {
    id: 'address',
    header: 'Address',
    sortValue: (row) => row.address,
    cellClassName: 'break-words',
    cell: (row) => (
      <div className="flex flex-col gap-1">
        <div className={addressFloorClassName(row.address)}>
          <AddressText text={row.address} />
        </div>
        {/* Narrow table: the Destinations column is hidden and its list
            stacks under the address instead. */}
        <div className="@lg:hidden">
          <AliasDestinationsList recipients={row.recipients} withArrows />
        </div>
      </div>
    ),
  },
  {
    id: 'recipients',
    header: 'Destinations',
    headerClassName: 'hidden @lg:table-cell',
    cellClassName: 'hidden @lg:table-cell break-words',
    cell: (row) => <AliasDestinationsList recipients={row.recipients} />,
  },
  {
    id: 'type',
    header: 'Type',
    sortValue: (row) => row.type,
    cell: (row) => <Badge>{row.type}</Badge>,
  },
];

/**
 * `/mail/domains/:domain` — Overview/Mailboxes/Aliases for a derived
 * domain (UX_ARCHITECTURE.md §6.2, §6.3). No delete control: a domain
 * disappears on its own once nothing here references it any more; this
 * page's job is to show exactly what still does.
 */
export function DomainDetailPage() {
  const { domain = '' } = useParams<{ domain: string }>();
  const navigate = useNavigate();
  const query = useDomainDetailQuery(domain);

  return (
    <div className="flex flex-col gap-6">
      <Button variant="ghost" size="sm" onClick={() => navigate('/mail/domains')} className="w-fit">
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        Back to domains
      </Button>

      {query.isError ? (
        <ErrorState
          message="Could not load this domain."
          errorId={
            query.error instanceof ApiError || query.error instanceof ApiClientError
              ? query.error.errorId
              : 'unknown'
          }
          onRetry={() => void query.refetch()}
        />
      ) : query.isLoading || !query.data ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          <PageHeader
            title={query.data.domain.domain}
            description={
              query.data.domain.aliasOnly
                ? 'This domain exists only because of the aliases below — it has no mailbox of its own.'
                : `${query.data.domain.mailboxCount} mailbox(es), ${query.data.domain.aliasCount} alias(es).`
            }
          />

          <Card>
            <CardHeader>
              <CardTitle>Mailboxes</CardTitle>
            </CardHeader>
            <CardContent>
              <DataTable
                data={query.data.mailboxes}
                columns={MAILBOX_COLUMNS}
                getRowId={(row) => row.email}
                caption={`Mailboxes in ${query.data.domain.domain}`}
                emptyState={
                  <EmptyState
                    variant="first-run"
                    title="No mailboxes in this domain"
                    description="This domain is kept alive only by its aliases."
                  />
                }
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Aliases</CardTitle>
            </CardHeader>
            {/* `@container`: the Destinations column hides by the card's own
                width, which the sidebar narrows at md-lg, not the viewport's. */}
            <CardContent className="@container">
              <DataTable
                data={query.data.aliases}
                columns={ALIAS_COLUMNS}
                getRowId={(row) => row.id}
                caption={`Aliases in ${query.data.domain.domain}`}
                emptyState={
                  <EmptyState
                    variant="first-run"
                    title="No aliases in this domain"
                    description="Aliases and forwards for this domain will appear here once you add one."
                  />
                }
              />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
