import { useState } from 'react';
import { toast } from 'sonner';
import { Play, RotateCw, Square } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable, type DataTableColumn } from '@/components/data-table';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/status/status-badge';
import type { Status } from '@/components/status/status';
import { ApiClientError, ApiError } from '@/lib/api-client';
import type { ContainerSummary } from '@dwg/shared';
import {
  useContainersQuery,
  useManagedContainerQuery,
  useRestartContainerMutation,
  useStartContainerMutation,
  useStopContainerMutation,
} from './use-docker-queries';

/** Docker's own `State` vocabulary (`running`, `exited`, `restarting`, `paused`, …) reduced to the six-state UI vocabulary — never the other direction, since Docker can report states this project has no obligation to invent a new status colour for. */
function statusForContainerState(state: string): Status {
  if (state === 'running') return 'healthy';
  if (state === 'restarting' || state === 'paused') return 'warning';
  if (state === 'exited' || state === 'dead') return 'critical';
  return 'unknown';
}

/**
 * `/docker/containers` (M9 — FEATURE_MATRIX.md §22-23). Every container
 * Docker knows about is listed for visibility; lifecycle actions (start/
 * stop/restart) only ever target "the" managed mail container — there is
 * no per-row action for any other container, matching the broker's own
 * container-identity resolution (ARCHITECTURE.md §6). **Recreate does not
 * ship** — it needs `container.create`, which the broker deliberately
 * lacks, so no such control appears here.
 */
export function ContainersPage() {
  const containersQuery = useContainersQuery();
  const managedQuery = useManagedContainerQuery();
  const startMutation = useStartContainerMutation();
  const stopMutation = useStopContainerMutation();
  const restartMutation = useRestartContainerMutation();
  const [confirmAction, setConfirmAction] = useState<'stop' | 'restart' | null>(null);

  const columns: DataTableColumn<ContainerSummary>[] = [
    {
      id: 'name',
      header: 'Name',
      sortValue: (row) => row.names[0] ?? row.id,
      cell: (row) => <span className="font-mono-sm">{row.names[0] ?? row.id}</span>,
    },
    { id: 'image', header: 'Image', sortValue: (row) => row.image, cell: (row) => row.image },
    {
      id: 'state',
      header: 'State',
      sortValue: (row) => row.state,
      cell: (row) => <StatusBadge status={statusForContainerState(row.state)} label={row.state} />,
    },
    { id: 'status', header: 'Status', sortValue: (row) => row.status, cell: (row) => row.status },
  ];

  const managed = managedQuery.data;
  const isManagedRunning = managed?.state.running ?? false;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Containers" description="Every container Docker knows about." />

      <Card>
        <CardHeader>
          <CardTitle className="text-body font-semibold">Mail container</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {managedQuery.isError ? (
            <ErrorState
              message="Could not load the mail container's state."
              errorId={
                managedQuery.error instanceof ApiError ||
                managedQuery.error instanceof ApiClientError
                  ? managedQuery.error.errorId
                  : 'unknown'
              }
              onRetry={() => void managedQuery.refetch()}
            />
          ) : managedQuery.isLoading || !managed ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono-sm text-body-sm">{managed.name}</span>
                  <StatusBadge
                    status={statusForContainerState(managed.state.status)}
                    label={managed.state.status}
                  />
                  {managed.state.health ? (
                    <Badge variant="outline">{managed.state.health}</Badge>
                  ) : null}
                </div>
                <p className="text-caption text-text-muted">
                  Restarted {managed.restartCount} time{managed.restartCount === 1 ? '' : 's'} —
                  image {managed.image}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={isManagedRunning}
                  pending={startMutation.isPending}
                  onClick={() =>
                    startMutation.mutate(undefined, {
                      onSuccess: () => toast.success('Mail container started'),
                      onError: () => toast.error('Could not start the mail container'),
                    })
                  }
                >
                  <Play className="size-3.5" aria-hidden="true" />
                  Start
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={!isManagedRunning}
                  onClick={() => setConfirmAction('stop')}
                >
                  <Square className="size-3.5" aria-hidden="true" />
                  Stop
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setConfirmAction('restart')}
                >
                  <RotateCw className="size-3.5" aria-hidden="true" />
                  Restart
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {containersQuery.isError ? (
        <ErrorState
          message="Could not load the container list."
          errorId={
            containersQuery.error instanceof ApiError ||
            containersQuery.error instanceof ApiClientError
              ? containersQuery.error.errorId
              : 'unknown'
          }
          onRetry={() => void containersQuery.refetch()}
        />
      ) : containersQuery.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <DataTable
          data={containersQuery.data ?? []}
          columns={columns}
          getRowId={(row) => row.id}
          caption="Every container on this Docker host"
          emptyState={
            <EmptyState
              variant="first-run"
              title="No containers"
              description="No containers exist on this Docker host yet."
            />
          }
        />
      )}

      <ConfirmDialog
        open={confirmAction === 'stop'}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null);
        }}
        tier={2}
        title="Stop the mail container?"
        description="Mail delivery, IMAP/POP3 access and every feature on this panel that depends on the mail container will be unavailable until it is started again."
        confirmLabel="Stop"
        destructive
        pending={stopMutation.isPending}
        onConfirm={() =>
          stopMutation.mutate(undefined, {
            onSuccess: () => {
              setConfirmAction(null);
              toast.success('Mail container stopped');
            },
            onError: () => toast.error('Could not stop the mail container'),
          })
        }
      />

      <ConfirmDialog
        open={confirmAction === 'restart'}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null);
        }}
        tier={2}
        title="Restart the mail container?"
        description="Mail delivery and every dependent feature will be briefly unavailable while the container restarts."
        confirmLabel="Restart"
        pending={restartMutation.isPending}
        onConfirm={() =>
          restartMutation.mutate(undefined, {
            onSuccess: () => {
              setConfirmAction(null);
              toast.success('Mail container restarted');
            },
            onError: () => toast.error('Could not restart the mail container'),
          })
        }
      />
    </div>
  );
}
