import { useState } from 'react';
import { toast } from 'sonner';
import { Ban, ShieldOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable, type DataTableColumn } from '@/components/data-table';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { UnsupportedNotice } from '@/components/unsupported-notice';
import { ApiClientError, ApiError } from '@/lib/api-client';
import {
  useBanIpMutation,
  useFail2banAllowlistMutation,
  useFail2banAllowlistQuery,
  useFail2banStatusQuery,
  useUnbanIpMutation,
} from './use-security-queries';

interface BannedIpRow {
  readonly ip: string;
}

/**
 * `/security/fail2ban` (`docs/research/03-mail-stack-components.md` §10).
 * `setup fail2ban status`'s exact output shape is `[UNCERTAIN]`, so the
 * raw text is always shown alongside the defensively-extracted banned-IP
 * table, never a fallback-only field. Unban is a mutation FEATURE_MATRIX.md
 * §16b requires confirmation for — gated behind `ConfirmDialog`.
 */
export function Fail2banPage() {
  const query = useFail2banStatusQuery();
  const banMutation = useBanIpMutation();
  const unbanMutation = useUnbanIpMutation();
  const [banInput, setBanInput] = useState('');
  const [unbanTarget, setUnbanTarget] = useState<string | null>(null);

  if (query.isError) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Fail2ban" description="Jail status and banned IPs." />
        <ErrorState
          message="Could not load Fail2ban status."
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
    return <Skeleton className="h-64 w-full" />;
  }

  const status = query.data;

  if (!status.capability.supported) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Fail2ban" description="Jail status and banned IPs." />
        <UnsupportedNotice
          reason={status.capability.reason ?? 'Fail2ban is unsupported on this deployment.'}
          docsHref="https://docker-mailserver.github.io/docker-mailserver/latest/config/security/fail2ban/"
        />
      </div>
    );
  }

  const columns: DataTableColumn<BannedIpRow>[] = [
    {
      id: 'ip',
      header: 'IP address',
      sortValue: (row) => row.ip,
      cell: (row) => row.ip,
      // A full IPv6 has no break opportunity (colons aren't one) and would
      // push the Unban column out of the scroll box on phones.
      cellClassName: 'break-all font-mono-sm',
    },
    {
      id: 'actions',
      header: '',
      cell: (row) => (
        <Button type="button" variant="secondary" size="sm" onClick={() => setUnbanTarget(row.ip)}>
          <ShieldOff className="size-3.5" aria-hidden="true" />
          Unban
        </Button>
      ),
    },
  ];

  const handleBan = () => {
    const ip = banInput.trim();
    if (!ip) return;
    banMutation.mutate(ip, {
      onSuccess: () => {
        setBanInput('');
        toast.success(`Banned ${ip}`);
      },
      onError: () => toast.error(`Could not ban ${ip}`),
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Fail2ban"
        description="Banned IPs across all jails and the Postfix allowlist."
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-body font-semibold">Ban an IP</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-56 flex-col gap-1.5">
            <Label htmlFor="ban-ip-input">IP address</Label>
            <Input
              id="ban-ip-input"
              value={banInput}
              onChange={(event) => setBanInput(event.target.value)}
              placeholder="203.0.113.5"
              autoComplete="off"
            />
          </div>
          <Button
            type="button"
            variant="secondary"
            pending={banMutation.isPending}
            disabled={banInput.trim().length === 0}
            onClick={handleBan}
          >
            <Ban className="size-3.5" aria-hidden="true" />
            Ban
          </Button>
        </CardContent>
      </Card>

      <DataTable
        data={status.bannedIps.map((ip) => ({ ip }))}
        columns={columns}
        getRowId={(row) => row.ip}
        caption="Currently banned IP addresses"
        emptyState={
          <EmptyState
            variant="first-run"
            title="No IPs are currently banned"
            description="Fail2ban bans an IP after repeated failed authentication attempts against Dovecot or Postfix."
          />
        }
      />

      <PostfixAllowlist />

      <Card>
        <CardHeader>
          <CardTitle className="text-body font-semibold">Raw jail status</CardTitle>
          <p className="text-caption text-text-muted">
            <code className="font-mono-sm">setup fail2ban status</code>&apos;s output shape is not
            independently confirmed, so it is always shown verbatim alongside the table above.
          </p>
        </CardHeader>
        <CardContent>
          <pre className="max-h-64 overflow-auto rounded-sm bg-bg-inset p-3 font-mono-sm text-text-secondary">
            {status.rawStatus || 'No status output.'}
          </pre>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={unbanTarget !== null}
        onOpenChange={(open) => {
          if (!open) setUnbanTarget(null);
        }}
        tier={2}
        title={`Unban ${unbanTarget ?? ''}?`}
        description="This immediately allows this IP to attempt to connect and authenticate again."
        confirmLabel="Unban"
        pending={unbanMutation.isPending}
        onConfirm={() => {
          if (!unbanTarget) return;
          const ip = unbanTarget;
          unbanMutation.mutate(ip, {
            onSuccess: () => {
              setUnbanTarget(null);
              toast.success(`Unbanned ${ip}`);
            },
            onError: () => toast.error(`Could not unban ${ip}`),
          });
        }}
      />
    </div>
  );
}

function PostfixAllowlist() {
  const query = useFail2banAllowlistQuery();
  const mutation = useFail2banAllowlistMutation();
  const [input, setInput] = useState('');
  const [change, setChange] = useState<{ action: 'add' | 'remove'; ip: string } | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-body font-semibold">Postfix allowlist</CardTitle>
        <p className="text-caption text-text-muted">
          Exempt trusted IPs from automatic Postfix bans. Adding an IP also lifts its active Postfix
          ban.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {query.isError ? (
          <ErrorState
            message="Could not load the Postfix allowlist."
            errorId={
              query.error instanceof ApiError || query.error instanceof ApiClientError
                ? query.error.errorId
                : 'unknown'
            }
            onRetry={() => void query.refetch()}
          />
        ) : query.isPending ? (
          <Skeleton className="h-20 w-full" />
        ) : (
          <>
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                const ip = input.trim();
                if (ip) setChange({ action: 'add', ip });
              }}
            >
              <div className="flex min-w-56 flex-col gap-2">
                <Label htmlFor="fail2ban-allowlist-ip">IP address to allow</Label>
                <Input
                  id="fail2ban-allowlist-ip"
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder="203.0.113.5"
                  autoComplete="off"
                  maxLength={64}
                />
              </div>
              <Button type="submit" disabled={!input.trim()} pending={mutation.isPending}>
                Add to allowlist
              </Button>
            </form>
            {query.data.length === 0 ? (
              <p className="text-caption text-text-muted">
                No IPs have been added to the allowlist.
              </p>
            ) : (
              <ul className="divide-y divide-border-subtle">
                {query.data.map((ip) => (
                  <li className="flex items-center justify-between gap-4 py-2" key={ip}>
                    <span className="break-all font-mono-sm">{ip}</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      aria-label={`Remove ${ip} from allowlist`}
                      onClick={() => setChange({ action: 'remove', ip })}
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </CardContent>
      <ConfirmDialog
        open={change !== null}
        onOpenChange={(open) => {
          if (!open) setChange(null);
        }}
        tier={2}
        title={
          change?.action === 'remove'
            ? `Remove ${change.ip} from the allowlist?`
            : `Allow ${change?.ip ?? ''}?`
        }
        description={
          change?.action === 'remove'
            ? 'Postfix Fail2ban can automatically ban this IP again.'
            : 'This lifts an active Postfix ban and exempts the IP from future automatic Postfix bans.'
        }
        confirmLabel={change?.action === 'remove' ? 'Remove' : 'Allow'}
        pending={mutation.isPending}
        onConfirm={() => {
          if (!change) return;
          mutation.mutate(change, {
            onSuccess: () => {
              if (change.action === 'add') setInput('');
              setChange(null);
              toast.success(
                change.action === 'add' ? 'IP allowlisted' : 'IP removed from allowlist',
              );
            },
            onError: (error) =>
              toast.error(
                error instanceof ApiError ? error.message : 'Could not update the allowlist',
              ),
          });
        }}
      />
    </Card>
  );
}
