import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Trash2 } from 'lucide-react';
import type { AliasSummary, AliasType } from '@dwg/shared';
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
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { UnsupportedNotice } from '@/components/unsupported-notice';
import { ApiClientError, ApiError } from '@/lib/api-client';
import {
  useAliasesQuery,
  useCreateAliasMutation,
  useDeleteAliasMutation,
  useDomainsQuery,
  useMailCapabilitiesQuery,
  useUpdateAliasMutation,
} from './use-mail-queries';

function typeBadgeVariant(type: AliasType): 'default' | 'outline' | 'neutral' {
  if (type === 'external') return 'outline';
  if (type === 'mixed') return 'neutral';
  return 'default';
}

function RecipientsEditor({
  recipients,
  onChange,
}: {
  recipients: string[];
  onChange: (recipients: string[]) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label>Destinations</Label>
      {recipients.map((recipient, index) => (
        <div key={index} className="flex gap-2">
          <Input
            type="email"
            value={recipient}
            onChange={(event) => {
              const next = [...recipients];
              next[index] = event.target.value;
              onChange(next);
            }}
            placeholder="user@example.com"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Remove destination"
            disabled={recipients.length <= 1}
            onClick={() => onChange(recipients.filter((_, i) => i !== index))}
          >
            <Trash2 className="size-4" aria-hidden="true" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="w-fit"
        onClick={() => onChange([...recipients, ''])}
      >
        <Plus className="size-3.5" aria-hidden="true" />
        Add destination
      </Button>
    </div>
  );
}

interface AliasFormDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly existing?: AliasSummary;
}

function AliasFormDialog({ open, onOpenChange, existing }: AliasFormDialogProps) {
  const [address, setAddress] = useState(existing?.address ?? '');
  const [recipients, setRecipients] = useState<string[]>(existing?.recipients ?? ['']);
  const [error, setError] = useState<string | null>(null);
  const createMutation = useCreateAliasMutation();
  const updateMutation = useUpdateAliasMutation();
  const pending = createMutation.isPending || updateMutation.isPending;

  function reset() {
    setAddress(existing?.address ?? '');
    setRecipients(existing?.recipients ?? ['']);
    setError(null);
  }

  function handleSubmit() {
    setError(null);
    const cleaned = recipients.map((r) => r.trim()).filter((r) => r.length > 0);
    if (cleaned.length === 0) {
      setError('At least one destination is required.');
      return;
    }
    if (!existing && address.trim().length === 0) {
      setError('Enter an alias address, or @domain.tld for a catch-all.');
      return;
    }

    if (existing) {
      updateMutation.mutate(
        { id: existing.id, input: { recipients: cleaned } },
        {
          onSuccess: () => {
            toast.success(`${existing.address} updated.`);
            onOpenChange(false);
          },
          onError: (err) =>
            setError(err instanceof ApiError ? err.message : 'Could not update the alias.'),
        },
      );
      return;
    }

    createMutation.mutate(
      { alias: address.trim(), recipients: cleaned },
      {
        onSuccess: () => {
          toast.success(`${address.trim()} created.`);
          reset();
          onOpenChange(false);
        },
        onError: (err) =>
          setError(err instanceof ApiError ? err.message : 'Could not create the alias.'),
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
          <DialogTitle>{existing ? `Edit ${existing.address}` : 'Add alias'}</DialogTitle>
          <DialogDescription>
            {existing
              ? 'Replaces the full destination list in one step.'
              : 'An alias whose destination is external is a forward — the same mechanism, just a different-looking destination.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {!existing ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="alias-address">Alias address</Label>
              <Input
                id="alias-address"
                autoFocus
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                placeholder="sales@example.com or @example.com"
              />
            </div>
          ) : null}

          <RecipientsEditor recipients={recipients} onChange={setRecipients} />

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
          <Button type="button" pending={pending} onClick={handleSubmit}>
            {existing ? 'Save changes' : 'Create alias'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AliasesPage() {
  const capabilities = useMailCapabilitiesQuery();
  const domainsQuery = useDomainsQuery();
  const [search, setSearch] = useState('');
  const [domainFilter, setDomainFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState<AliasType | ''>('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<AliasSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AliasSummary | null>(null);

  const query = useAliasesQuery({});
  const deleteMutation = useDeleteAliasMutation();
  const canManage = capabilities.data?.localAccountManagement.supported ?? true;

  const filtered = useMemo(() => {
    let aliases = query.data?.aliases ?? [];
    if (domainFilter) aliases = aliases.filter((a) => a.domain === domainFilter);
    if (typeFilter) aliases = aliases.filter((a) => a.type === typeFilter);
    if (search) {
      const needle = search.toLowerCase();
      aliases = aliases.filter(
        (a) =>
          a.address.toLowerCase().includes(needle) ||
          a.recipients.some((r) => r.toLowerCase().includes(needle)),
      );
    }
    return aliases;
  }, [query.data, domainFilter, typeFilter, search]);

  const dependentsOf = (alias: AliasSummary) =>
    (query.data?.aliases ?? []).filter(
      (a) => a.id !== alias.id && a.recipients.includes(alias.address),
    );

  const columns: DataTableColumn<AliasSummary>[] = [
    {
      id: 'address',
      header: 'Address',
      sortValue: (row) => row.address,
      cell: (row) => (
        <span className="font-medium text-text-primary">
          {row.address}
          {row.isCatchAll ? (
            <Badge variant="outline" className="ml-2">
              Catch-all
            </Badge>
          ) : null}
        </span>
      ),
    },
    {
      id: 'recipients',
      header: 'Destinations',
      cell: (row) => <span className="text-text-secondary">{row.recipients.join(', ')}</span>,
    },
    { id: 'domain', header: 'Domain', sortValue: (row) => row.domain, cell: (row) => row.domain },
    {
      id: 'type',
      header: 'Type',
      sortValue: (row) => row.type,
      cell: (row) => <Badge variant={typeBadgeVariant(row.type)}>{row.type}</Badge>,
    },
  ];

  const activeFilters = [
    ...(search ? [`Search: ${search}`] : []),
    ...(domainFilter ? [`Domain: ${domainFilter}`] : []),
    ...(typeFilter ? [`Type: ${typeFilter}`] : []),
  ];

  const dependents = deleteTarget ? dependentsOf(deleteTarget) : [];
  const deleteTier = dependents.length > 0 ? 3 : 2;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Aliases"
        description="Aliases and forwarding are the same mechanism in docker-mailserver — an alias whose destination is external is a forward. The Type column shows which."
        action={
          canManage ? <Button onClick={() => setCreateOpen(true)}>Add alias</Button> : undefined
        }
      />

      {!canManage && capabilities.data ? (
        <UnsupportedNotice
          reason={
            capabilities.data.localAccountManagement.reason ??
            'Local alias management is unsupported on this deployment.'
          }
        />
      ) : null}

      {query.isError ? (
        <ErrorState
          message="Could not load aliases."
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
              placeholder="Search aliases…"
              className="max-w-xs"
              aria-label="Search aliases"
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
            <select
              value={typeFilter}
              onChange={(event) => setTypeFilter(event.target.value as AliasType | '')}
              aria-label="Filter by type"
              className="h-9 rounded-sm border border-border-default bg-bg-surface px-3 text-body-sm text-text-primary"
            >
              <option value="">All types</option>
              <option value="internal">Internal</option>
              <option value="external">External</option>
              <option value="mixed">Mixed</option>
            </select>
          </div>

          <DataTable
            data={filtered}
            columns={columns}
            getRowId={(row) => row.id}
            caption="Aliases"
            initialSort={{ id: 'address', desc: false }}
            rowActions={
              canManage
                ? (row) => (
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setEditTarget(row)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(row)}>
                        Delete
                      </Button>
                    </div>
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
                    setTypeFilter('');
                  }}
                />
              ) : (
                <EmptyState
                  variant="first-run"
                  title="No aliases yet"
                  description="Add an alias to forward mail from one address to one or more destinations."
                  action={
                    canManage
                      ? { label: 'Add alias', onClick: () => setCreateOpen(true) }
                      : undefined
                  }
                />
              )
            }
          />
        </div>
      )}

      <AliasFormDialog open={createOpen} onOpenChange={setCreateOpen} />
      {editTarget ? (
        <AliasFormDialog
          open={editTarget !== null}
          onOpenChange={(open) => !open && setEditTarget(null)}
          existing={editTarget}
        />
      ) : null}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(null);
        }}
        tier={deleteTier}
        title="Delete alias"
        description={
          deleteTier === 2
            ? `Removes ${deleteTarget?.address} and all ${deleteTarget?.recipients.length ?? 0} of its destinations. Mail sent to this address will bounce.`
            : 'This alias is itself a destination for other aliases — deleting it changes their behaviour too.'
        }
        destructive
        resourceName={deleteTier === 3 ? (deleteTarget?.address ?? '') : undefined}
        impactSummary={
          deleteTier === 3 ? (
            <div className="flex flex-col gap-1">
              <p>
                Removes <strong>{deleteTarget?.address}</strong> and all of its destinations.
              </p>
              <p>
                {dependents.length} other alias(es) forward to this address and will lose that
                recipient: {dependents.map((d) => d.address).join(', ')}
              </p>
            </div>
          ) : undefined
        }
        pending={deleteMutation.isPending}
        onConfirm={() => {
          if (!deleteTarget) return;
          deleteMutation.mutate(deleteTarget.id, {
            onSuccess: () => {
              toast.success(`${deleteTarget.address} deleted.`);
              setDeleteTarget(null);
            },
            onError: (err) =>
              toast.error(err instanceof ApiError ? err.message : 'Could not delete the alias.'),
          });
        }}
      />
    </div>
  );
}
