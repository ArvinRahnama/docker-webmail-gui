import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { DomainSummary } from '@dwg/shared';
import { DataTable, type DataTableColumn } from '@/components/data-table';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiClientError, ApiError } from '@/lib/api-client';
import { useDomainsQuery } from '@/mail/use-mail-queries';

/**
 * `/security/email-auth` (UX_ARCHITECTURE.md §5.2, §6.2). Lists the same
 * derived domains M7's Domains page knows about (FEATURE_MATRIX.md §2) —
 * this page's own job is only to route to a per-domain live DNS check,
 * so it deliberately does **not** run a live resolver query per row on
 * load: N domains would mean N live checks just to render a list,
 * against a rate-limited endpoint (SECURITY.md §3.4) that this page has
 * no business spending on an admin who has not asked to check anything
 * yet.
 */
export function EmailAuthListPage() {
  const navigate = useNavigate();
  const query = useDomainsQuery();
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const domains = query.data?.domains ?? [];
    if (!search) return domains;
    const needle = search.toLowerCase();
    return domains.filter((d) => d.domain.toLowerCase().includes(needle));
  }, [query.data, search]);

  const columns: DataTableColumn<DomainSummary>[] = [
    {
      id: 'domain',
      header: 'Domain',
      sortValue: (row) => row.domain,
      cell: (row) => (
        <button
          type="button"
          onClick={() => navigate(`/security/email-auth/${encodeURIComponent(row.domain)}`)}
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
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Email Authentication"
        description="MX, SPF, DKIM, DMARC and reverse DNS, checked live against public DNS for each of your domains."
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
                  description="A domain appears here once a mailbox or alias references it."
                />
              )
            }
          />
        </div>
      )}
    </div>
  );
}
