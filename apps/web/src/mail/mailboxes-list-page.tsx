import { useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { MoreHorizontal } from 'lucide-react';
import type { MailboxRestrictScope, MailboxSummary } from '@dwg/shared';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable, type DataTableColumn } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/page-header';
import { PasswordField } from '@/components/password-field';
import { Skeleton } from '@/components/ui/skeleton';
import { UnsupportedNotice } from '@/components/unsupported-notice';
import { ApiClientError, ApiError } from '@/lib/api-client';
import { formatQuota } from '@/lib/format';
import { NewPasswordSchema } from '@dwg/shared';
import { toast } from 'sonner';
import {
  useBulkQuotaMailboxesMutation,
  useBulkRestrictMailboxesMutation,
  useCreateMailboxMutation,
  useDeleteMailboxMutation,
  useDomainsQuery,
  useMailCapabilitiesQuery,
  useMailboxDetailQuery,
  useMailboxesQuery,
  useRestrictMailboxMutation,
} from './use-mail-queries';

const LIST_PAGE_SIZE = 200; // "effectively all" — DataTable owns display pagination client-side.

function RestrictionBadges({ mailbox }: { mailbox: MailboxSummary }) {
  if (!mailbox.restricted.send && !mailbox.restricted.receive) {
    return <span className="text-text-muted">—</span>;
  }
  return (
    <div className="flex gap-1">
      {mailbox.restricted.send ? <Badge variant="outline">Send restricted</Badge> : null}
      {mailbox.restricted.receive ? <Badge variant="outline">Receive restricted</Badge> : null}
    </div>
  );
}

function CreateMailboxDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const createMutation = useCreateMailboxMutation();

  function reset() {
    setEmail('');
    setPassword('');
    setConfirmPassword('');
    setError(null);
  }

  function handleSubmit() {
    setError(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('Enter a valid email address.');
      return;
    }
    const passwordResult = NewPasswordSchema.safeParse(password);
    if (!passwordResult.success) {
      setError(passwordResult.error.issues[0]?.message ?? 'Invalid password.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    createMutation.mutate(
      { email, password },
      {
        onSuccess: () => {
          toast.success(`Mailbox ${email} created.`);
          reset();
          onOpenChange(false);
        },
        onError: (err) => {
          setError(err instanceof ApiError ? err.message : 'Could not create the mailbox.');
        },
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add mailbox</DialogTitle>
          <DialogDescription>
            Creates a new local mailbox. If this is the first mailbox for its domain, the domain
            appears automatically on the Domains page.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-mailbox-email">Email address</Label>
            <Input
              id="new-mailbox-email"
              type="email"
              autoFocus
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="user@example.com"
            />
          </div>

          <PasswordField
            id="new-mailbox-password"
            label="Password"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
          />
          <PasswordField
            id="new-mailbox-confirm-password"
            label="Confirm password"
            value={confirmPassword}
            onChange={setConfirmPassword}
            autoComplete="new-password"
            allowGenerate={false}
            showStrength={false}
          />

          {error ? (
            <p role="alert" className="text-body-sm text-status-critical-fg">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" pending={createMutation.isPending} onClick={handleSubmit}>
            Create mailbox
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface RestrictAction {
  readonly address: string;
  readonly scope: MailboxRestrictScope;
  readonly restricted: boolean;
}

interface BulkRestrictAction {
  readonly scope: MailboxRestrictScope;
  readonly restricted: boolean;
}

export function MailboxesListPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const capabilities = useMailCapabilitiesQuery();
  const domainsQuery = useDomainsQuery();
  const [search, setSearch] = useState('');
  const [domainFilter, setDomainFilter] = useState('');
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(
    Boolean((location.state as { openCreate?: boolean } | null)?.openCreate),
  );
  const [restrictAction, setRestrictAction] = useState<RestrictAction | null>(null);
  const [deleteAddress, setDeleteAddress] = useState<string | null>(null);
  const [mailDataChoice, setMailDataChoice] = useState<'delete' | 'keep' | null>(null);
  const [bulkRestrictAction, setBulkRestrictAction] = useState<BulkRestrictAction | null>(null);
  const [bulkQuotaOpen, setBulkQuotaOpen] = useState(false);
  const [bulkQuotaValue, setBulkQuotaValue] = useState('');
  const [bulkQuotaClear, setBulkQuotaClear] = useState(false);

  const query = useMailboxesQuery({ domain: domainFilter || undefined, pageSize: LIST_PAGE_SIZE });
  const restrictMutation = useRestrictMailboxMutation();
  const deleteMutation = useDeleteMailboxMutation();
  const bulkRestrictMutation = useBulkRestrictMailboxesMutation();
  const bulkQuotaMutation = useBulkQuotaMailboxesMutation();
  const deleteImpactQuery = useMailboxDetailQuery(deleteAddress ?? '');

  const canManage = capabilities.data?.localAccountManagement.supported ?? true;

  const filtered = useMemo(() => {
    const mailboxes = query.data?.mailboxes ?? [];
    if (!search) return mailboxes;
    const needle = search.toLowerCase();
    return mailboxes.filter((m) => m.email.toLowerCase().includes(needle));
  }, [query.data, search]);

  const columns: DataTableColumn<MailboxSummary>[] = [
    {
      id: 'email',
      header: 'Address',
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
      header: 'Quota',
      sortValue: (row) => row.quota ?? '',
      cell: (row) => formatQuota(row.quota),
    },
    { id: 'status', header: 'Status', cell: (row) => <RestrictionBadges mailbox={row} /> },
  ];

  const activeFilters = [
    ...(search ? [`Search: ${search}`] : []),
    ...(domainFilter ? [`Domain: ${domainFilter}`] : []),
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Mailboxes"
        description="Local mailboxes managed by docker-mailserver."
        action={
          canManage ? <Button onClick={() => setCreateOpen(true)}>Add mailbox</Button> : undefined
        }
      />

      {!canManage && capabilities.data ? (
        <UnsupportedNotice
          reason={
            capabilities.data.localAccountManagement.reason ??
            'Local mailbox management is unsupported on this deployment.'
          }
        />
      ) : null}

      {query.isError ? (
        <ErrorState
          message="Could not load mailboxes."
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
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search mailboxes…"
              className="max-w-xs"
              aria-label="Search mailboxes"
            />
            <select
              value={domainFilter}
              onChange={(event) => setDomainFilter(event.target.value)}
              aria-label="Filter by domain"
              className="h-9 rounded-sm border border-border-default bg-bg-surface px-3 text-body-sm text-text-primary"
            >
              <option value="">All domains</option>
              {(domainsQuery.data?.domains ?? []).map((d) => (
                <option key={d.domain} value={d.domain}>
                  {d.domain}
                </option>
              ))}
            </select>

            {selectedIds.size > 0 && canManage ? (
              <div className="ml-auto flex items-center gap-2 text-body-sm text-text-secondary">
                <span>{selectedIds.size} selected</span>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setBulkRestrictAction({ scope: 'send', restricted: true })}
                >
                  Restrict sending
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setBulkQuotaOpen(true)}>
                  Set quota
                </Button>
              </div>
            ) : null}
          </div>

          <DataTable
            data={filtered}
            columns={columns}
            getRowId={(row) => row.email}
            caption="Mailboxes"
            initialSort={{ id: 'email', desc: false }}
            selectedIds={canManage ? selectedIds : undefined}
            onSelectedIdsChange={canManage ? setSelectedIds : undefined}
            rowActions={
              canManage
                ? (row) => (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" aria-label={`Actions for ${row.email}`}>
                          <MoreHorizontal className="size-4" aria-hidden="true" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() =>
                            navigate(`/mail/mailboxes/${encodeURIComponent(row.email)}`)
                          }
                        >
                          View detail
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() =>
                            setRestrictAction({
                              address: row.email,
                              scope: 'send',
                              restricted: !row.restricted.send,
                            })
                          }
                        >
                          {row.restricted.send ? 'Allow sending' : 'Restrict sending'}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() =>
                            setRestrictAction({
                              address: row.email,
                              scope: 'receive',
                              restricted: !row.restricted.receive,
                            })
                          }
                        >
                          {row.restricted.receive ? 'Allow receiving' : 'Restrict receiving'}
                        </DropdownMenuItem>
                        <DropdownMenuItem destructive onClick={() => setDeleteAddress(row.email)}>
                          Delete…
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )
                : undefined
            }
            emptyState={
              activeFilters.length > 0 ? (
                <EmptyState
                  variant="filtered"
                  activeFilters={activeFilters}
                  onClearFilters={() => {
                    setSearch('');
                    setDomainFilter('');
                  }}
                />
              ) : (
                <EmptyState
                  variant="first-run"
                  title="No mailboxes yet"
                  description="Add your first mailbox to start receiving mail."
                  action={
                    canManage
                      ? { label: 'Add mailbox', onClick: () => setCreateOpen(true) }
                      : undefined
                  }
                />
              )
            }
          />
        </div>
      )}

      <CreateMailboxDialog open={createOpen} onOpenChange={setCreateOpen} />

      <ConfirmDialog
        open={restrictAction !== null}
        onOpenChange={(next) => {
          if (!next) setRestrictAction(null);
        }}
        tier={2}
        title={restrictAction?.restricted ? 'Restrict mailbox' : 'Remove restriction'}
        description={
          restrictAction?.restricted
            ? `Mail ${restrictAction.scope === 'send' ? 'sent from' : 'delivered to'} ${restrictAction?.address} will be blocked until this restriction is removed. This does not disable the account or block IMAP/POP3 login.`
            : `${restrictAction?.address} will be able to ${restrictAction?.scope === 'send' ? 'send' : 'receive'} mail again.`
        }
        destructive={restrictAction?.restricted ?? false}
        pending={restrictMutation.isPending}
        onConfirm={() => {
          if (!restrictAction) return;
          restrictMutation.mutate(restrictAction, {
            onSuccess: () => {
              toast.success('Restriction updated.');
              setRestrictAction(null);
            },
            onError: (err) =>
              toast.error(
                err instanceof ApiError ? err.message : 'Could not update the restriction.',
              ),
          });
        }}
      />

      <ConfirmDialog
        open={bulkRestrictAction !== null}
        onOpenChange={(next) => {
          if (!next) setBulkRestrictAction(null);
        }}
        tier={2}
        title="Restrict selected mailboxes"
        description={`Sending will be blocked for ${selectedIds.size} mailbox(es) until the restriction is removed individually.`}
        destructive
        pending={bulkRestrictMutation.isPending}
        onConfirm={() => {
          if (!bulkRestrictAction) return;
          bulkRestrictMutation.mutate(
            {
              addresses: [...selectedIds],
              scope: bulkRestrictAction.scope,
              restricted: bulkRestrictAction.restricted,
            },
            {
              onSuccess: (data) => {
                const failures = data.results.filter((r) => !r.ok);
                toast[failures.length > 0 ? 'warning' : 'success'](
                  failures.length > 0
                    ? `${failures.length} of ${data.results.length} failed.`
                    : 'Restriction applied to every selected mailbox.',
                );
                setBulkRestrictAction(null);
                setSelectedIds(new Set());
              },
              onError: (err) =>
                toast.error(err instanceof ApiError ? err.message : 'Bulk restrict failed.'),
            },
          );
        }}
      />

      <Dialog open={bulkQuotaOpen} onOpenChange={setBulkQuotaOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set quota for {selectedIds.size} mailbox(es)</DialogTitle>
            <DialogDescription>Applies the same quota to every selected mailbox.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="bulk-quota-value">Quota (e.g. 2G, 500M)</Label>
              <Input
                id="bulk-quota-value"
                value={bulkQuotaValue}
                onChange={(event) => setBulkQuotaValue(event.target.value)}
                disabled={bulkQuotaClear}
                placeholder="2G"
              />
            </div>
            <label className="flex items-center gap-2 text-body-sm text-text-secondary">
              <input
                type="checkbox"
                checked={bulkQuotaClear}
                onChange={(event) => setBulkQuotaClear(event.target.checked)}
              />
              Clear quota (unlimited) instead
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setBulkQuotaOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              pending={bulkQuotaMutation.isPending}
              disabled={!bulkQuotaClear && bulkQuotaValue.length === 0}
              onClick={() => {
                bulkQuotaMutation.mutate(
                  { addresses: [...selectedIds], quota: bulkQuotaClear ? null : bulkQuotaValue },
                  {
                    onSuccess: (data) => {
                      const failures = data.results.filter((r) => !r.ok);
                      toast[failures.length > 0 ? 'warning' : 'success'](
                        failures.length > 0
                          ? `${failures.length} of ${data.results.length} failed.`
                          : 'Quota applied to every selected mailbox.',
                      );
                      setBulkQuotaOpen(false);
                      setBulkQuotaValue('');
                      setBulkQuotaClear(false);
                      setSelectedIds(new Set());
                    },
                    onError: (err) =>
                      toast.error(err instanceof ApiError ? err.message : 'Bulk quota failed.'),
                  },
                );
              }}
            >
              Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteAddress !== null}
        onOpenChange={(next) => {
          if (!next) {
            setDeleteAddress(null);
            setMailDataChoice(null);
          }
        }}
        tier={3}
        title="Delete mailbox"
        description="This permanently removes the account. There is no trash."
        destructive
        resourceName={deleteAddress ?? ''}
        pending={deleteMutation.isPending}
        impactSummary={
          <div className="flex flex-col gap-3">
            <p>
              Deletes <strong>{deleteAddress}</strong>
              {deleteImpactQuery.data
                ? deleteImpactQuery.data.dependentAliases.length > 0
                  ? ` — ${deleteImpactQuery.data.dependentAliases.length} alias(es) currently point at this address and will lose that recipient.`
                  : '. No aliases point at this address.'
                : '…'}
            </p>
            <p className="text-caption text-text-muted">
              Backup status: not tracked in this build — verify a recent backup separately before
              proceeding.
            </p>
            <fieldset className="flex flex-col gap-1.5">
              <legend className="text-body-sm font-medium text-text-primary">
                Mail data — this choice has no default
              </legend>
              <label className="flex items-center gap-2 text-body-sm">
                <input
                  type="radio"
                  name="mail-data-choice"
                  checked={mailDataChoice === 'keep'}
                  onChange={() => setMailDataChoice('keep')}
                />
                Delete account, keep mail on disk
              </label>
              <label className="flex items-center gap-2 text-body-sm">
                <input
                  type="radio"
                  name="mail-data-choice"
                  checked={mailDataChoice === 'delete'}
                  onChange={() => setMailDataChoice('delete')}
                />
                Delete account and its mail
              </label>
            </fieldset>
          </div>
        }
        onConfirm={() => {
          if (!deleteAddress) return;
          if (!mailDataChoice) {
            toast.error('Choose whether to keep or delete the mail data before confirming.');
            return;
          }
          deleteMutation.mutate(
            { address: deleteAddress, mailData: mailDataChoice },
            {
              onSuccess: () => {
                toast.success(`${deleteAddress} deleted.`);
                setDeleteAddress(null);
                setMailDataChoice(null);
              },
              onError: (err) =>
                toast.error(
                  err instanceof ApiError ? err.message : 'Could not delete the mailbox.',
                ),
            },
          );
        }}
      />
    </div>
  );
}
