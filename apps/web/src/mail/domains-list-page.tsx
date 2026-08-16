import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { DomainSummary } from '@dwg/shared';
import { DataTable, type DataTableColumn } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiClientError, ApiError } from '@/lib/api-client';
import { useDomainsQuery } from './use-mail-queries';

/**
 * `/mail/domains` (UX_ARCHITECTURE.md §6.2, §6.3). **There is no "Add
 * domain" button anywhere on this page** — docker-mailserver has no
 * `setup domain` command; a domain exists purely because a mailbox or
 * alias references it (FEATURE_MATRIX.md §2). The page says so in one
 * line and offers *Add mailbox* instead, which is the operation that
 * actually brings a new domain into being.
 */
export function DomainsListPage() {
  const navigate = useNavigate();
  const query = useDomainsQuery();
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const domains = query.data?.domains ?? [];
    if (!search) return domains;
    const needle = search.toLowerCase();
    return domains.filter((d) => d.domain.toLowerCase().includes(needle));
  }, [query.data, search]);

  const goToAddMailbox = () => navigate('/mail/mailboxes', { state: { openCreate: true } });

  const columns: DataTableColumn<DomainSummary>[] = [
    {
      id: 'domain',
      header: 'Domain',
      sortValue: (row) => row.domain,
      cell: (row) => (
        <button
          type="button"
          onClick={() => navigate(`/mail/domains/${encodeURIComponent(row.domain)}`)}
          className="font-medium text-accent hover:underline"
        >
          {row.domain}
        </button>
      ),
    },
    {
      id: 'mailboxes',
      header: 'Mailboxes',
      sortValue: (row) => row.mailboxCount,
      cell: (row) => row.mailboxCount,
    },
    {
      id: 'aliases',
      header: 'Aliases',
      sortValue: (row) => row.aliasCount,
      cell: (row) => row.aliasCount,
    },
    {
      id: 'status',
      header: 'Status',
      cell: (row) =>
        row.aliasOnly ? (
          <Badge variant="outline">Alias-only</Badge>
        ) : (
          <Badge variant="neutral">Has mailboxes</Badge>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Domains"
        description="Derived from your mailboxes and aliases — docker-mailserver has no domain object of its own, so there is no Add or Delete domain control here. Add a mailbox for a new domain and it appears automatically."
        action={<Button onClick={goToAddMailbox}>Add mailbox</Button>}
      />

      {query.isError ? (
        <ErrorState
          message="Could not load domains."
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
        <div className="flex flex-col gap-3">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search domains…"
            className="max-w-xs"
            aria-label="Search domains"
          />
          <DataTable
            data={filtered}
            columns={columns}
            getRowId={(row) => row.domain}
            caption="Domains"
            initialSort={{ id: 'domain', desc: false }}
            emptyState={
              search ? (
                <EmptyState
                  variant="filtered"
                  activeFilters={[`Search: ${search}`]}
                  onClearFilters={() => setSearch('')}
                />
              ) : (
                <EmptyState
                  variant="first-run"
                  title="No domains yet"
                  description="A domain appears here the moment its first mailbox or alias exists. Add a mailbox to get started."
                  action={{ label: 'Add mailbox', onClick: goToAddMailbox }}
                />
              )
            }
          />
        </div>
      )}
    </div>
  );
}
