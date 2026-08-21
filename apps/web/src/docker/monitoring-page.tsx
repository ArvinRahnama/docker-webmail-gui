import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState } from '@/components/error-state';
import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiClientError, ApiError } from '@/lib/api-client';
import { useMonitoringQuery } from './use-docker-queries';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function StatTile({
  label,
  value,
  caption,
}: {
  label: string;
  value: string;
  caption?: string | undefined;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border-default bg-bg-surface p-4">
      <span className="text-caption text-text-muted">{label}</span>
      <span className="text-h2 font-semibold text-text-primary">{value}</span>
      {caption ? <span className="text-caption text-text-muted">{caption}</span> : null}
    </div>
  );
}

/**
 * `/docker/monitoring` (M9 — FEATURE_MATRIX.md §33-34). A live snapshot, not
 * a time series — the "spam trend"-style sampling this project uses
 * elsewhere has no equivalent here yet (`MonitoringService`'s own doc
 * comment). Read-only.
 */
export function MonitoringPage() {
  const query = useMonitoringQuery();

  if (query.isError) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Monitoring" description="A live snapshot of resource usage." />
        <ErrorState
          message="Could not load the monitoring snapshot."
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
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Monitoring" description="A live snapshot of resource usage." />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const { stats, system, version, df } = query.data;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Monitoring"
        description={`Live snapshot, sampled ${new Date(stats.sampledAt).toLocaleTimeString()}.`}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-body font-semibold">Mail container resource usage</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatTile label="CPU" value={`${stats.cpuPercent.toFixed(1)}%`} />
          <StatTile
            label="Memory"
            value={`${stats.memory.percent.toFixed(1)}%`}
            caption={`${formatBytes(stats.memory.usageBytes)} / ${formatBytes(stats.memory.limitBytes)}`}
          />
          <StatTile label="PIDs" value={stats.pids === null ? '—' : String(stats.pids)} />
          <StatTile
            label="Network"
            value={stats.network ? formatBytes(stats.network.rxBytes + stats.network.txBytes) : '—'}
            caption={
              stats.network
                ? `rx ${formatBytes(stats.network.rxBytes)} / tx ${formatBytes(stats.network.txBytes)}`
                : undefined
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-body font-semibold">Docker host</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatTile
            label="Containers"
            value={String(system.containers)}
            caption={`${system.containersRunning} running`}
          />
          <StatTile
            label="Images"
            value={String(system.images)}
            caption={`${df.imagesCount} tracked`}
          />
          <StatTile label="Volumes" value={String(df.volumesCount)} />
          <StatTile
            label="CPUs"
            value={String(system.ncpu)}
            caption={formatBytes(system.memTotal)}
          />
        </CardContent>
        <CardContent className="pt-0 text-caption text-text-muted">
          {system.serverVersion} ({version.os}/{version.arch}) — driver {system.driver} — kernel{' '}
          {version.kernelVersion}
        </CardContent>
      </Card>
    </div>
  );
}
