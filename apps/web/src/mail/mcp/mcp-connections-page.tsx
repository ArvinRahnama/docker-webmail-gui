/**
 * Mail → MCP Connections (`/mail/mcp`). Postmaster-only: the server refuses
 * every request behind this page without `mcp:manage`.
 *
 * Shows the MCP service's real state (deployed? enabled? healthy? version
 * aligned?), connection counts, a searchable table of connections, and
 * recent activity/failures — all straight from apps/mcp, never estimated.
 * A connection's "last connected" is exactly what apps/mcp recorded, or
 * "Never".
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  Ban,
  Bot,
  CircleCheck,
  Clock,
  Plus,
  Settings,
  ShieldOff,
  XOctagon,
} from 'lucide-react';
import {
  MCP_CONNECTION_STATUSES,
  type CreateMcpConnectionResponse,
  type McpConnectionStatus,
  type McpConnectionSummary,
} from '@dwg/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable, type DataTableColumn } from '@/components/data-table';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { Input } from '@/components/ui/input';
import { MetricTile } from '@/components/metric-tile';
import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/status/status-badge';
import { UnsupportedNotice } from '@/components/unsupported-notice';
import { BreakableText } from '@/components/breakable-text';
import { ApiClientError, ApiError } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { CONNECTION_STATUS_DISPLAY, formatEventDate } from './mcp-ui';
import { EventList } from './event-list';
import { CreateConnectionDialog } from './create-connection-dialog';
import { McpSettingsDialog } from './mcp-settings-dialog';
import { OneTimeCredentialDialog } from './one-time-credential-dialog';
import { useMcpConnectionsQuery, useMcpStatusQuery } from './use-mcp-queries';

const WIDE_ONLY = 'hidden @3xl:table-cell';

const SCOPE_SHORT: Record<string, string> = {
  'mail.read': 'Read',
  'mail.send': 'Send',
  'mail.delete': 'Delete',
};

function errorIdOf(error: unknown): string {
  return error instanceof ApiError || error instanceof ApiClientError ? error.errorId : 'unknown';
}

export function McpConnectionsPage() {
  const navigate = useNavigate();
  const status = useMcpStatusQuery();
  const deployed = status.data?.deployed === true;
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<McpConnectionStatus | ''>('');
  const connections = useMcpConnectionsQuery(
    { ...(statusFilter ? { status: statusFilter } : {}) },
    deployed,
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [created, setCreated] = useState<CreateMcpConnectionResponse | null>(null);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const list = connections.data?.connections ?? [];
    if (!needle) return list;
    return list.filter(
      (c) =>
        c.mailbox.includes(needle) ||
        c.label.toLowerCase().includes(needle) ||
        c.id.includes(needle),
    );
  }, [connections.data, search]);

  const columns: DataTableColumn<McpConnectionSummary>[] = [
    {
      id: 'mailbox',
      header: 'Mailbox',
      sortValue: (row) => row.mailbox,
      cell: (row) => (
        <div className="flex min-w-0 flex-col">
          <span className="font-medium text-text-primary">
            <BreakableText text={row.mailbox} />
          </span>
          <span className="text-caption text-text-muted">{row.label}</span>
        </div>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (row) => row.status,
      cell: (row) => (
        <StatusBadge
          status={CONNECTION_STATUS_DISPLAY[row.status].status}
          label={CONNECTION_STATUS_DISPLAY[row.status].label}
        />
      ),
    },
    {
      id: 'permissions',
      header: 'Permissions',
      cell: (row) => (
        <div className="flex flex-wrap gap-1">
          {row.permissions.map((p) => (
            <Badge key={p} variant={p === 'mail.read' ? 'neutral' : 'default'}>
              {SCOPE_SHORT[p]}
            </Badge>
          ))}
        </div>
      ),
    },
    {
      id: 'id',
      header: 'Connection',
      headerClassName: WIDE_ONLY,
      cellClassName: `${WIDE_ONLY} font-mono text-caption`,
      cell: (row) => row.id.slice(0, 10) + '…',
    },
    {
      id: 'created',
      header: 'Created',
      headerClassName: WIDE_ONLY,
      cellClassName: WIDE_ONLY,
      sortValue: (row) => row.createdAt,
      cell: (row) => formatDateTime(row.createdAt),
    },
    {
      id: 'lastAuthorized',
      header: 'Last connected',
      headerClassName: WIDE_ONLY,
      cellClassName: WIDE_ONLY,
      sortValue: (row) => row.lastAuthorizedAt ?? '',
      cell: (row) => formatEventDate(row.lastAuthorizedAt),
    },
    {
      id: 'lastUsed',
      header: 'Last activity',
      sortValue: (row) => row.lastUsedAt ?? '',
      cell: (row) => formatEventDate(row.lastUsedAt),
    },
    {
      id: 'expires',
      header: 'Expires',
      headerClassName: WIDE_ONLY,
      cellClassName: WIDE_ONLY,
      sortValue: (row) => row.expiresAt ?? 'z',
      cell: (row) => formatEventDate(row.expiresAt, 'Never'),
    },
  ];

  const service = status.data?.service ?? null;
  const counts = service?.counts;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="MCP Connections"
        description="Issue isolated, per-mailbox MCP connections that a mailbox owner authorizes in a compatible AI client such as ChatGPT. Only postmasters can see or manage this page."
        action={
          deployed ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setSettingsOpen(true)}>
                <Settings aria-hidden="true" />
                Service settings
              </Button>
              <Button
                variant="primary"
                disabled={service?.enabled !== true}
                onClick={() => setCreateOpen(true)}
              >
                <Plus aria-hidden="true" />
                Generate connection
              </Button>
            </div>
          ) : undefined
        }
      />

      {status.isError ? (
        <ErrorState
          message="Could not load the MCP service status."
          errorId={errorIdOf(status.error)}
          onRetry={() => void status.refetch()}
        />
      ) : status.isLoading ? (
        <Skeleton className="h-28 w-full" />
      ) : !deployed ? (
        <UnsupportedNotice
          reason={status.data?.reason ?? 'The MCP service is not available on this install.'}
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              MCP service
              {service?.enabled ? (
                <StatusBadge status="healthy" label="Enabled" />
              ) : (
                <StatusBadge status="unknown" label="Disabled" />
              )}
              {service?.vault !== 'ok' ? (
                <StatusBadge
                  status="critical"
                  label={
                    service?.vault === 'key_mismatch' ? 'Vault key mismatch' : 'Vault key missing'
                  }
                />
              ) : null}
              {service?.mailBackend === 'fake' ? (
                <StatusBadge status="warning" label="Development fake mail backend" />
              ) : null}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-body-sm">
            <p>
              Public endpoint:{' '}
              {service?.publicBaseUrl ? (
                <code className="break-all font-mono">{service.publicBaseUrl}</code>
              ) : (
                <span className="text-status-warning-fg">not set</span>
              )}
            </p>
            {!service?.enabled ? (
              <p className="text-text-secondary">
                MCP is off. Set the public endpoint and enable it in Service settings to start
                issuing connections.
              </p>
            ) : null}
          </CardContent>
        </Card>
      )}

      {deployed && counts ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <MetricTile label="Total" value={counts.total} icon={Bot} />
          <MetricTile label="Active" value={counts.active} icon={CircleCheck} />
          <MetricTile label="Awaiting authorization" value={counts.pending} icon={Clock} />
          <MetricTile label="Disabled" value={counts.disabled} icon={Ban} />
          <MetricTile
            label="Suspended"
            value={counts.suspended + counts.expired}
            icon={ShieldOff}
          />
          <MetricTile label="Revoked" value={counts.revoked} icon={XOctagon} />
        </div>
      ) : null}

      {deployed ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by mailbox, label or id…"
              className="max-w-xs"
              aria-label="Search connections"
            />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as McpConnectionStatus | '')}
              aria-label="Filter by status"
              className="h-9 max-w-full rounded-sm border border-border-default bg-bg-surface px-3 text-body-sm text-text-primary sm:max-w-xs"
            >
              <option value="">All statuses</option>
              {MCP_CONNECTION_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {CONNECTION_STATUS_DISPLAY[s].label}
                </option>
              ))}
            </select>
          </div>
          {connections.isError ? (
            <ErrorState
              message="Could not load MCP connections."
              errorId={errorIdOf(connections.error)}
              onRetry={() => void connections.refetch()}
            />
          ) : (
            <DataTable
              data={filtered}
              columns={columns}
              getRowId={(row) => row.id}
              caption="MCP connections"
              isLoading={connections.isLoading}
              initialSort={{ id: 'mailbox', desc: false }}
              rowActions={(row) => (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => navigate(`/mail/mcp/${row.id}`)}
                  aria-label={`Manage connection for ${row.mailbox}`}
                >
                  Manage
                </Button>
              )}
              emptyState={
                search || statusFilter ? (
                  <EmptyState
                    variant="filtered"
                    activeFilters={[
                      ...(search ? [`Search: ${search}`] : []),
                      ...(statusFilter
                        ? [`Status: ${CONNECTION_STATUS_DISPLAY[statusFilter].label}`]
                        : []),
                    ]}
                    onClearFilters={() => {
                      setSearch('');
                      setStatusFilter('');
                    }}
                  />
                ) : (
                  <EmptyState
                    variant="first-run"
                    icon={Bot}
                    title="No MCP connections yet"
                    description="Generate a connection for a mailbox, then deliver its one-time setup credentials to the mailbox owner."
                    action={
                      service?.enabled
                        ? { label: 'Generate connection', onClick: () => setCreateOpen(true) }
                        : undefined
                    }
                  />
                )
              }
            />
          )}
        </div>
      ) : null}

      {deployed && service ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Activity className="size-4" aria-hidden="true" />
                Recent activity
              </CardTitle>
            </CardHeader>
            <CardContent>
              <EventList events={service.recentEvents} empty="No MCP activity recorded yet." />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle className="size-4" aria-hidden="true" />
                Recent failures
              </CardTitle>
            </CardHeader>
            <CardContent>
              <EventList events={service.recentFailures} empty="No failures recorded." />
            </CardContent>
          </Card>
        </div>
      ) : null}

      <CreateConnectionDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={setCreated}
      />
      <McpSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <OneTimeCredentialDialog
        title="Connection generated"
        credential={created?.oneTimeCredential ?? null}
        mailbox={created?.connection.mailbox ?? ''}
        mcpUrl={created?.connection.mcpUrl ?? null}
        permissions={created?.connection.permissions ?? []}
        onClose={() => {
          const id = created?.connection.id;
          setCreated(null);
          if (id) navigate(`/mail/mcp/${id}`);
        }}
      />
    </div>
  );
}
