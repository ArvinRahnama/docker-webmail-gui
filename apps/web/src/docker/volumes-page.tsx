import { useState } from 'react';
import { toast } from 'sonner';
import { ShieldAlert, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable, type DataTableColumn } from '@/components/data-table';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { UnsupportedNotice } from '@/components/unsupported-notice';
import { ApiClientError, ApiError } from '@/lib/api-client';
import type { DockerVolume } from '@dwg/shared';
import { useRemoveVolumeMutation, useVolumesQuery } from './use-docker-queries';

/**
 * `/docker/volumes` (M9 — FEATURE_MATRIX.md §25). `isProtected` is a
 * **display hint** computed server-side from the managed container's live
 * mounts — it is not the safety boundary. A protected volume's Remove
 * button is disabled here purely so an admin never even attempts a
 * doomed request; the actual refusal happens broker-side regardless of
 * what this page shows (`apps/broker/src/operations.ts`), which is why
 * `useRemoveVolumeMutation`'s error path is still handled below rather
 * than assumed unreachable.
 */
export function VolumesPage() {
  const query = useVolumesQuery();
  const removeMutation = useRemoveVolumeMutation();
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);

  const columns: DataTableColumn<DockerVolume>[] = [
    {
      id: 'name',
      header: 'Name',
      sortValue: (row) => row.name,
      cell: (row) => (
        <div className="flex items-center gap-2">
          <span className="font-mono-sm">{row.name}</span>
          {row.isProtected ? (
            <Badge variant="outline" className="gap-1">
              <ShieldAlert className="size-3" aria-hidden="true" />
              Protected
            </Badge>
          ) : null}
        </div>
      ),
    },
    { id: 'driver', header: 'Driver', sortValue: (row) => row.driver, cell: (row) => row.driver },
    {
      id: 'mountpoint',
      header: 'Mountpoint',
      cell: (row) => <span className="font-mono-sm text-text-secondary">{row.mountpoint}</span>,
    },
    {
      id: 'actions',
      header: '',
      cell: (row) =>
        row.isProtected ? (
          <UnsupportedNotice
            variant="tooltip"
            reason="This volume backs mail data, state, logs, or configuration and can never be removed through this panel."
          >
            <Button type="button" variant="secondary" size="sm" disabled>
              <Trash2 className="size-3.5" aria-hidden="true" />
              Remove
            </Button>
          </UnsupportedNotice>
        ) : (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setRemoveTarget(row.name)}
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
            Remove
          </Button>
        ),
    },
  ];

  if (query.isError) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Volumes" description="Every Docker volume on this host." />
        <ErrorState
          message="Could not load the volume list."
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
      <PageHeader
        title="Volumes"
        description="Every Docker volume on this host. Volumes backing mail data are protected and can never be removed here."
      />

      {query.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <DataTable
          data={query.data ?? []}
          columns={columns}
          getRowId={(row) => row.name}
          caption="Every Docker volume on this host"
          emptyState={
            <EmptyState
              variant="first-run"
              title="No volumes"
              description="No volumes exist yet."
            />
          }
        />
      )}

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
        tier={3}
        title={`Remove volume ${removeTarget ?? ''}?`}
        destructive
        description="This permanently deletes the volume and everything stored in it. This cannot be undone."
        impactSummary={
          <>
            Deletes volume <span className="font-mono-sm font-semibold">{removeTarget}</span> and
            all of its data, permanently.
          </>
        }
        resourceName={removeTarget ?? ''}
        confirmLabel="Remove"
        pending={removeMutation.isPending}
        onConfirm={() => {
          if (!removeTarget) return;
          const name = removeTarget;
          removeMutation.mutate(name, {
            onSuccess: () => {
              setRemoveTarget(null);
              toast.success(`Removed volume ${name}`);
            },
            onError: (error) => {
              toast.error(
                error instanceof ApiError ? error.message : `Could not remove volume ${name}`,
              );
            },
          });
        }}
      />
    </div>
  );
}
