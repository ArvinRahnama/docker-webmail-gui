import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { AlertTriangle, ListX, Plus, Trash2 } from 'lucide-react';
import {
  SENDER_ENTRY_KINDS,
  validateSenderEntryValue,
  type SenderEntryKind,
  type SenderList,
  type SenderListEntry,
} from '@dwg/shared';
import { DataTable, type DataTableColumn } from '@/components/data-table';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiClientError, ApiError } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { SenderReportsTable } from './sender-reports-table';
import { SpamIntegrationNotice } from './spam-integration-notice';
import {
  useAddSenderListEntryMutation,
  useRemoveSenderListEntryMutation,
  useSenderListsQuery,
  useSenderReportsQuery,
} from './use-security-queries';

const SELECT_CLASS =
  'h-9 w-full rounded-sm border border-border-default bg-bg-surface px-3 text-body-sm text-text-primary';

const KIND_LABELS: Record<SenderEntryKind, string> = {
  address: 'Address',
  domain: 'Domain',
  ip: 'Client IP',
};

const KIND_PLACEHOLDERS: Record<SenderEntryKind, string> = {
  address: 'news@example.com',
  domain: 'example.com (subdomains included)',
  ip: '203.0.113.7',
};

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'The change could not be saved.';
}

/**
 * `/security/sender-lists/:user` — one mailbox's allow and block lists.
 * Entries are kept in the mailbox's own `dwg-sender-lists` Sieve script,
 * which the mail server reads at delivery time.
 */
export function SenderListsPage() {
  const { user: encodedUser } = useParams<{ user: string }>();
  const mailbox = encodedUser ? decodeURIComponent(encodedUser) : '';

  const listsQuery = useSenderListsQuery(mailbox);
  const reportsQuery = useSenderReportsQuery(mailbox);
  const addMutation = useAddSenderListEntryMutation(mailbox);
  const removeMutation = useRemoveSenderListEntryMutation(mailbox);

  const [list, setList] = useState<SenderList>('allow');
  const [kind, setKind] = useState<SenderEntryKind>('domain');
  const [value, setValue] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  if (listsQuery.isError) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Sender Lists" description={mailbox} />
        <ErrorState
          message="Could not load this mailbox's sender lists."
          errorId={
            listsQuery.error instanceof ApiError || listsQuery.error instanceof ApiClientError
              ? listsQuery.error.errorId
              : 'unknown'
          }
          onRetry={() => void listsQuery.refetch()}
        />
      </div>
    );
  }

  if (listsQuery.isLoading || !listsQuery.data) {
    return <Skeleton className="h-96 w-full" />;
  }

  const data = listsQuery.data;

  const onAdd = (event: FormEvent) => {
    event.preventDefault();
    const normalised = value.trim().toLowerCase();
    const invalid = validateSenderEntryValue(kind, normalised);
    if (invalid !== null) {
      setFormError(invalid);
      return;
    }
    setFormError(null);
    addMutation.mutate(
      { list, kind, value: normalised },
      {
        onSuccess: () => {
          toast.success(`${list === 'allow' ? 'Allowed' : 'Blocked'} ${normalised}`);
          setValue('');
        },
        onError: (err) => setFormError(errorMessage(err)),
      },
    );
  };

  const onRemove = (entry: SenderListEntry) => {
    removeMutation.mutate(
      { list: entry.list, kind: entry.kind, value: entry.value },
      {
        onSuccess: () => toast.success(`Removed ${entry.value}`),
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  };

  const columns: DataTableColumn<SenderListEntry>[] = [
    {
      id: 'value',
      header: 'Sender',
      cell: (e) => <span className="break-words font-medium">{e.value}</span>,
      sortValue: (e) => e.value,
    },
    {
      id: 'kind',
      header: 'Type',
      cell: (e) => <span className="text-text-secondary">{KIND_LABELS[e.kind]}</span>,
      sortValue: (e) => e.kind,
    },
    {
      id: 'source',
      header: 'Added by',
      cell: (e) => (
        <Badge variant="neutral">{e.source === 'report' ? 'User report' : 'Administrator'}</Badge>
      ),
      sortValue: (e) => e.source,
    },
    {
      id: 'addedAt',
      header: 'Added',
      cell: (e) => <span className="whitespace-nowrap">{formatDateTime(e.addedAt)}</span>,
      sortValue: (e) => e.addedAt,
    },
  ];

  const table = (which: SenderList) => (
    <DataTable
      data={data.entries.filter((e) => e.list === which)}
      columns={columns}
      getRowId={(e) => `${e.kind}:${e.value}`}
      caption={which === 'allow' ? 'Allowed senders' : 'Blocked senders'}
      initialSort={{ id: 'addedAt', desc: true }}
      rowActions={(e) => (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`Remove ${e.value}`}
          onClick={() => onRemove(e)}
          disabled={removeMutation.isPending}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      )}
      emptyState={
        <EmptyState
          variant="first-run"
          icon={ListX}
          title={which === 'allow' ? 'No allowed senders' : 'No blocked senders'}
          description={
            which === 'allow'
              ? 'Senders appear here when this user moves their mail out of Junk, or when you add them.'
              : 'Senders appear here when this user moves their mail into Junk, or when you add them.'
          }
        />
      }
    />
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Sender Lists"
        description={`${mailbox} — ${data.entries.length} of ${data.maxEntries} entries`}
      />
      <SpamIntegrationNotice integration={data.integration} />

      {data.unrecognisedContent ? (
        <div className="flex items-start gap-2 rounded-md border border-status-warning-fg/30 bg-status-warning-bg px-4 py-3 text-body-sm text-status-warning-fg">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p>
            This mailbox's <code className="font-mono-sm">dwg-sender-lists</code> Sieve script was
            edited by hand, so its entries cannot be shown. The next change made here replaces it.
          </p>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-body font-semibold">Add a sender</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={onAdd}
            className="grid gap-3 sm:grid-cols-[9rem_9rem_1fr_auto] sm:items-end"
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sender-list">List</Label>
              <select
                id="sender-list"
                className={SELECT_CLASS}
                value={list}
                onChange={(event) => setList(event.target.value as SenderList)}
              >
                <option value="allow">Allow</option>
                <option value="block">Block</option>
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sender-kind">Type</Label>
              <select
                id="sender-kind"
                className={SELECT_CLASS}
                value={kind}
                onChange={(event) => setKind(event.target.value as SenderEntryKind)}
              >
                {SENDER_ENTRY_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sender-value">Sender</Label>
              <Input
                id="sender-value"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder={KIND_PLACEHOLDERS[kind]}
                aria-invalid={formError !== null ? true : undefined}
                aria-describedby={formError !== null ? 'sender-value-error' : undefined}
              />
            </div>
            <Button type="submit" variant="primary" pending={addMutation.isPending}>
              <Plus aria-hidden="true" />
              Add
            </Button>
          </form>
          {formError !== null ? (
            <p
              id="sender-value-error"
              role="alert"
              className="mt-2 text-caption text-status-critical-fg"
            >
              {formError}
            </p>
          ) : null}
          <p className="mt-3 text-caption text-text-muted">
            A sender that is allowed is never put in Junk for this mailbox — unless the message
            fails DMARC for a domain that asks for rejection, which means the address is forged.
            Adding a sender to one list takes it off the other.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-body font-semibold">Allowed</CardTitle>
        </CardHeader>
        <CardContent>{table('allow')}</CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-body font-semibold">Blocked</CardTitle>
        </CardHeader>
        <CardContent>{table('block')}</CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-body font-semibold">Reports from this mailbox</CardTitle>
        </CardHeader>
        <CardContent>
          <SenderReportsTable
            reports={reportsQuery.data ?? []}
            isLoading={reportsQuery.isLoading}
            showMailbox={false}
          />
        </CardContent>
      </Card>
    </div>
  );
}
