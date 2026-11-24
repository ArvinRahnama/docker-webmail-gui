import { useId, useState, type FormEvent, type ReactNode } from 'react';
import {
  Fail2banAllowlistIpSchema,
  validateIpAddress,
  type Fail2banStatusResponse,
} from '@dwg/shared';
import {
  Ban,
  ChevronDown,
  Copy,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Terminal,
} from 'lucide-react';
import { toast } from 'sonner';
import { BreakableText } from '@/components/breakable-text';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable, type DataTableColumn } from '@/components/data-table';
import { ErrorState } from '@/components/error-state';
import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { UnsupportedNotice } from '@/components/unsupported-notice';
import { ApiClientError, ApiError } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import {
  useBanIpMutation,
  useFail2banAllowlistMutation,
  useFail2banAllowlistQuery,
  useFail2banStatusQuery,
  useUnbanIpMutation,
} from './use-security-queries';

type Action = 'ban' | 'unban' | 'allow' | 'remove';
type Change = { readonly action: Action; readonly ip: string };
type IpRow = { readonly ip: string };

const actionCopy = {
  ban: {
    label: 'Ban IP',
    prompt: 'Ban',
    description: 'This IP will be blocked from connecting to services protected by Fail2ban.',
    success: 'Banned',
  },
  unban: {
    label: 'Unban IP',
    prompt: 'Unban',
    description: 'This lifts the current ban. Fail2ban can ban the IP again.',
    success: 'Unbanned',
  },
  allow: {
    label: 'Allow IP',
    prompt: 'Allow',
    description:
      'This lifts a Postfix ban on this IP and exempts it from future automatic Postfix bans.',
    success: 'Allowlisted',
  },
  remove: {
    label: 'Remove exception',
    prompt: 'Remove exception for',
    description: 'Postfix Fail2ban can automatically ban this IP again.',
    success: 'Removed exception for',
  },
} satisfies Record<Action, { label: string; prompt: string; description: string; success: string }>;

const ipColumns: DataTableColumn<IpRow>[] = [
  {
    id: 'ip',
    header: 'IP address',
    cell: ({ ip }) => <BreakableText text={ip} separators=":." />,
    sortValue: ({ ip }) => ip,
    cellClassName: 'break-words font-mono-sm',
  },
];

function errorId(error: unknown): string {
  return error instanceof ApiError || error instanceof ApiClientError ? error.errorId : 'unknown';
}

export function Fail2banPage() {
  const status = useFail2banStatusQuery();

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader title="Fail2ban" description="Manage IP bans and trusted Postfix exceptions." />
      {status.data ? (
        status.data.capability.supported ? (
          <Fail2banWorkspace
            status={status.data}
            refreshing={status.isFetching}
            refreshStatus={async () => (await status.refetch()).isSuccess}
          />
        ) : (
          <UnsupportedNotice
            reason={status.data.capability.reason ?? 'Fail2ban is unsupported on this deployment.'}
            docsHref="https://docker-mailserver.github.io/docker-mailserver/latest/config/security/fail2ban/"
          />
        )
      ) : status.isError ? (
        <ErrorState
          message="Could not load Fail2ban status."
          errorId={errorId(status.error)}
          onRetry={() => void status.refetch()}
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2" role="status" aria-label="Loading Fail2ban">
          <Skeleton className="h-56 w-full" />
          <Skeleton className="h-56 w-full" />
        </div>
      )}
    </div>
  );
}

function Fail2banWorkspace({
  status,
  refreshing,
  refreshStatus,
}: {
  readonly status: Fail2banStatusResponse;
  readonly refreshing: boolean;
  readonly refreshStatus: () => Promise<boolean>;
}) {
  const allowlist = useFail2banAllowlistQuery();
  const banMutation = useBanIpMutation();
  const unbanMutation = useUnbanIpMutation();
  const allowlistMutation = useFail2banAllowlistMutation();
  const [filter, setFilter] = useState('');
  const [bannedInput, setBannedInput] = useState('');
  const [allowedInput, setAllowedInput] = useState('');
  const [change, setChange] = useState<Change | null>(null);
  const pending = banMutation.isPending || unbanMutation.isPending || allowlistMutation.isPending;
  const isRefreshing = refreshing || allowlist.isFetching;
  const query = filter.trim().toLowerCase();

  function confirmChange() {
    if (!change) return;
    const { action, ip } = change;
    const handlers = {
      onSuccess() {
        if (action === 'ban') setBannedInput('');
        if (action === 'allow') setAllowedInput('');
        setChange(null);
        toast.success(`${actionCopy[action].success} ${ip}`);
      },
      onError(error: Error) {
        toast.error(error instanceof ApiError ? error.message : `Could not update ${ip}.`);
      },
    };

    if (action === 'ban') banMutation.mutate(ip, handlers);
    else if (action === 'unban') unbanMutation.mutate(ip, handlers);
    else allowlistMutation.mutate({ action: action === 'allow' ? 'add' : 'remove', ip }, handlers);
  }

  const selectedAction = change && actionCopy[change.action];

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative min-w-0 flex-1 basis-60 sm:max-w-sm">
          <Label htmlFor="fail2ban-filter" className="sr-only">
            Filter IP addresses
          </Label>
          <Search
            className="pointer-events-none absolute left-3 top-2.5 size-4 text-text-muted"
            aria-hidden="true"
          />
          <Input
            id="fail2ban-filter"
            type="search"
            className="pl-9"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter both lists by IP"
            autoCapitalize="none"
            spellCheck={false}
          />
        </div>
        <Button
          type="button"
          pending={isRefreshing}
          onClick={() => {
            void Promise.all([refreshStatus(), allowlist.refetch()]).then(([statusOk, allow]) => {
              if (!statusOk || allow.isError) toast.error('Could not refresh both Fail2ban lists.');
            });
          }}
        >
          {isRefreshing ? null : <RefreshCw aria-hidden="true" />}
          Refresh
        </Button>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <IpPanel title="Banned IPs" action="ban" count={status.bannedIps.length}>
          <IpForm
            action="ban"
            value={bannedInput}
            onChange={setBannedInput}
            ips={status.bannedIps}
            pending={pending}
            onRequest={setChange}
          />
          <IpList
            title="Banned IPs"
            ips={status.bannedIps}
            query={query}
            action="unban"
            pending={pending}
            onRequest={setChange}
          />
        </IpPanel>

        <IpPanel title="Postfix allowlist" action="allow" count={allowlist.data?.length}>
          {allowlist.data ? (
            <>
              <IpForm
                action="allow"
                value={allowedInput}
                onChange={setAllowedInput}
                ips={allowlist.data}
                pending={pending}
                onRequest={setChange}
              />
              <IpList
                title="Postfix allowlist"
                ips={allowlist.data}
                query={query}
                action="remove"
                pending={pending}
                onRequest={setChange}
              />
            </>
          ) : allowlist.isError ? (
            <ErrorState
              message="Could not load the Postfix allowlist."
              errorId={errorId(allowlist.error)}
              onRetry={() => void allowlist.refetch()}
            />
          ) : (
            <Skeleton className="h-24 w-full" />
          )}
        </IpPanel>
      </div>

      <JailDiagnostics rawStatus={status.rawStatus} />

      <ConfirmDialog
        open={change !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setChange(null);
        }}
        tier={2}
        title={change && selectedAction ? `${selectedAction.prompt} ${change.ip}?` : ''}
        description={selectedAction?.description ?? ''}
        confirmLabel={selectedAction?.label ?? 'Confirm'}
        destructive={change?.action === 'ban'}
        pending={pending}
        onConfirm={confirmChange}
      />
    </>
  );
}

function IpPanel({
  title,
  action,
  count,
  children,
}: {
  readonly title: string;
  readonly action: 'ban' | 'allow';
  readonly count: number | undefined;
  readonly children: ReactNode;
}) {
  const headingId = useId();
  const isBan = action === 'ban';
  const Icon = isBan ? Ban : ShieldCheck;

  return (
    <section aria-labelledby={headingId} className="min-w-0">
      <Card>
        <CardHeader className="flex-row items-start gap-3 sm:p-5">
          <div
            className={cn(
              'flex size-9 shrink-0 items-center justify-center rounded-md',
              isBan
                ? 'bg-status-critical-bg text-status-critical-fg'
                : 'bg-status-healthy-bg text-status-healthy-fg',
            )}
          >
            <Icon className="size-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id={headingId} className="text-h2 font-semibold text-text-primary">
                {title}
              </h2>
              {count === undefined ? null : <Badge variant="neutral">{count}</Badge>}
            </div>
            <p className="mt-1 text-body-sm text-text-secondary">
              {isBan
                ? 'Active bans across all Fail2ban jails.'
                : 'Trusted IPs exempt from automatic Postfix bans.'}
            </p>
          </div>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-4 sm:px-5 sm:pb-5">
          {children}
        </CardContent>
      </Card>
    </section>
  );
}

function IpForm({
  action,
  value,
  onChange,
  ips,
  pending,
  onRequest,
}: {
  readonly action: 'ban' | 'allow';
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly ips: readonly string[];
  readonly pending: boolean;
  readonly onRequest: (change: Change) => void;
}) {
  const inputId = useId();
  const errorMessageId = useId();
  const [error, setError] = useState('');
  const isBan = action === 'ban';
  const Icon = isBan ? Ban : Plus;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const ip = value.trim();
    if (!Fail2banAllowlistIpSchema.safeParse(ip).success || (isBan && validateIpAddress(ip))) {
      setError('Enter a valid IPv4 or IPv6 address.');
      return;
    }
    if (ips.some((entry) => entry.toLowerCase() === ip.toLowerCase())) {
      setError(isBan ? 'This IP is already banned.' : 'This IP is already on the allowlist.');
      return;
    }
    onRequest({ action, ip });
  }

  return (
    <form className="flex min-w-0 flex-col gap-2" onSubmit={submit}>
      <Label htmlFor={inputId}>{isBan ? 'IP address to ban' : 'IP address to allow'}</Label>
      <div className="flex flex-wrap items-start gap-2">
        <Input
          id={inputId}
          className="min-w-0 flex-1 basis-40 font-mono-sm"
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
            if (error) setError('');
          }}
          placeholder={isBan ? '203.0.113.5' : '198.51.100.5'}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={64}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorMessageId : undefined}
        />
        <Button
          type="submit"
          variant={isBan ? 'secondary' : 'primary'}
          disabled={pending || !value.trim()}
        >
          <Icon aria-hidden="true" />
          {actionCopy[action].label}
        </Button>
      </div>
      {error ? (
        <p id={errorMessageId} role="alert" className="text-body-sm text-status-critical-fg">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function IpList({
  title,
  ips,
  query,
  action,
  pending,
  onRequest,
}: {
  readonly title: string;
  readonly ips: readonly string[];
  readonly query: string;
  readonly action: 'unban' | 'remove';
  readonly pending: boolean;
  readonly onRequest: (change: Change) => void;
}) {
  const isBanList = action === 'unban';
  const rows = ips.filter((ip) => ip.toLowerCase().includes(query)).map((ip) => ({ ip }));

  return (
    <DataTable
      key={query}
      data={rows}
      columns={ipColumns}
      getRowId={({ ip }) => ip}
      caption={title}
      initialSort={{ id: 'ip', desc: false }}
      pageSize={10}
      hideSinglePagePagination
      rowActions={({ ip }) => (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={isBanList ? `Unban ${ip}` : `Remove ${ip} from allowlist`}
          disabled={pending}
          onClick={() => onRequest({ action, ip })}
        >
          {isBanList ? 'Unban' : 'Remove'}
        </Button>
      )}
      emptyState={
        <p className="rounded-md border border-dashed border-border-default bg-bg-inset p-4 text-body-sm text-text-secondary">
          {ips.length > 0 && query
            ? 'No IPs match your filter.'
            : isBanList
              ? 'No IPs are currently banned.'
              : 'No Postfix exceptions have been added.'}
        </p>
      }
    />
  );
}

function JailDiagnostics({ rawStatus }: { readonly rawStatus: string }) {
  return (
    <details className="group min-w-0 rounded-md border border-border-default bg-bg-surface shadow-sm">
      <summary className="flex cursor-pointer list-none items-center gap-3 rounded-md px-4 py-3 text-body font-medium text-text-primary [&::-webkit-details-marker]:hidden">
        <Terminal className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
        Jail diagnostics
        <ChevronDown
          className="ml-auto size-4 shrink-0 text-text-muted group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="flex flex-col gap-3 border-t border-border-subtle px-4 py-3">
        {rawStatus ? (
          <Button
            type="button"
            size="sm"
            className="self-end"
            onClick={() => {
              if (!navigator.clipboard) {
                toast.error('Clipboard unavailable. Select and copy the status text.');
                return;
              }
              void navigator.clipboard.writeText(rawStatus).then(
                () => toast.success('Jail status copied.'),
                () => toast.error('Could not copy jail status.'),
              );
            }}
          >
            <Copy aria-hidden="true" />
            Copy status
          </Button>
        ) : null}
        <pre className="max-h-72 overflow-auto rounded-md bg-bg-inset p-3 font-mono-sm text-text-secondary">
          {rawStatus || 'No jail status was returned.'}
        </pre>
      </div>
    </details>
  );
}
