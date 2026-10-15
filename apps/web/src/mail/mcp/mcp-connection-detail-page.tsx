/**
 * One MCP connection (`/mail/mcp/:id`): what it is bound to, what it may do,
 * whether it works, who authorized it, what it has done — and every control
 * the postmaster has over it. Destructive actions go through `ConfirmDialog`
 * tiers (UX_ARCHITECTURE.md §8): disable/reissue/rotate are tier 2 (state the
 * consequence), revoke and delete are tier 3 (type the mailbox to confirm).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ArrowLeft,
  FlaskConical,
  KeyRound,
  Power,
  PowerOff,
  RefreshCw,
  RotateCcw,
  Trash2,
  XOctagon,
} from 'lucide-react';
import {
  buildMcpSetupInstructionsText,
  MCP_SCOPE_LABELS,
  MCP_SCOPES,
  type McpConnectionTestResult,
  type McpCredentialIssueResponse,
  type McpScope,
} from '@dwg/shared';
import { BreakableText } from '@/components/breakable-text';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ErrorState } from '@/components/error-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/status/status-badge';
import { Switch } from '@/components/ui/switch';
import { ApiClientError, ApiError } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import {
  CONNECTION_STATUS_DISPLAY,
  CopyButton,
  CREDENTIAL_HEALTH_DISPLAY,
  enrollmentLabel,
  formatEventDate,
} from './mcp-ui';
import { EventList } from './event-list';
import { OneTimeCredentialDialog } from './one-time-credential-dialog';
import {
  useDeleteMcpConnectionMutation,
  useMcpConnectionAuditQuery,
  useMcpConnectionQuery,
  useReissueMcpCredentialMutation,
  useRevokeMcpGrantMutation,
  useRotateMcpCredentialMutation,
  useSetMcpConnectionStateMutation,
  useTestMcpConnectionMutation,
  useUpdateMcpConnectionMutation,
  useUpdateMcpMailboxCredentialMutation,
} from './use-mcp-queries';

type PendingAction = 'disable' | 'revoke' | 'delete' | 'reissue' | 'rotate' | null;

function message(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
      <dt className="w-44 shrink-0 text-body-sm text-text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-body-sm text-text-primary">{children}</dd>
    </div>
  );
}

export function McpConnectionDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const query = useMcpConnectionQuery(id);
  const audit = useMcpConnectionAuditQuery(id);
  const update = useUpdateMcpConnectionMutation(id);
  const setState = useSetMcpConnectionStateMutation(id);
  const remove = useDeleteMcpConnectionMutation(id);
  const reissue = useReissueMcpCredentialMutation(id);
  const rotate = useRotateMcpCredentialMutation(id);
  const test = useTestMcpConnectionMutation(id);
  const provision = useUpdateMcpMailboxCredentialMutation(id);
  const revokeGrant = useRevokeMcpGrantMutation(id);

  const [pending, setPending] = useState<PendingAction>(null);
  const [issued, setIssued] = useState<McpCredentialIssueResponse | null>(null);
  const [scopes, setScopes] = useState<McpScope[]>([]);
  const [identities, setIdentities] = useState('');
  const [testResult, setTestResult] = useState<McpConnectionTestResult | null>(null);
  const [provisionOpen, setProvisionOpen] = useState(false);
  const [mailboxPassword, setMailboxPassword] = useState('');
  const [grantToRevoke, setGrantToRevoke] = useState<string | null>(null);

  const connection = query.data?.connection;
  useEffect(() => {
    if (connection) {
      setScopes([...connection.permissions]);
      setIdentities(connection.senderIdentities.join(', '));
    }
  }, [connection]);

  if (query.isError) {
    return (
      <ErrorState
        message="Could not load this MCP connection."
        errorId={
          query.error instanceof ApiError || query.error instanceof ApiClientError
            ? query.error.errorId
            : 'unknown'
        }
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (query.isLoading || !connection) return <Skeleton className="h-64 w-full" />;

  const revoked = connection.status === 'revoked';
  const statusDisplay = CONNECTION_STATUS_DISPLAY[connection.status];
  const health = CREDENTIAL_HEALTH_DISPLAY[connection.credentialHealth];
  const scopesChanged = scopes.join(' ') !== connection.permissions.join(' ');
  const mcpUrl = connection.mcpUrl ?? '';

  const issueCallbacks = {
    onSuccess: (response: McpCredentialIssueResponse) => {
      setPending(null);
      setIssued(response);
    },
    onError: (err: unknown) => toast.error(message(err, 'Could not issue new setup credentials.')),
  };

  return (
    <div className="flex flex-col gap-6">
      <Button variant="ghost" size="sm" onClick={() => navigate('/mail/mcp')} className="w-fit">
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        Back to MCP connections
      </Button>

      <PageHeader
        title={connection.label}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <BreakableText text={connection.mailbox} />
            <StatusBadge status={statusDisplay.status} label={statusDisplay.label} />
          </span>
        }
        action={
          revoked ? (
            <Button variant="destructive" onClick={() => setPending('delete')}>
              <Trash2 aria-hidden="true" />
              Delete record
            </Button>
          ) : (
            <div className="flex flex-wrap gap-2">
              {connection.status === 'disabled' ? (
                <Button
                  pending={setState.isPending}
                  onClick={() =>
                    setState.mutate(
                      { action: 'enable' },
                      {
                        onSuccess: () => toast.success('Connection enabled.'),
                        onError: (err) => toast.error(message(err, 'Could not enable.')),
                      },
                    )
                  }
                >
                  <Power aria-hidden="true" />
                  Enable
                </Button>
              ) : (
                <Button onClick={() => setPending('disable')}>
                  <PowerOff aria-hidden="true" />
                  Disable
                </Button>
              )}
              <Button variant="destructive" onClick={() => setPending('revoke')}>
                <XOctagon aria-hidden="true" />
                Revoke
              </Button>
            </div>
          )
        }
      />

      {connection.statusReason && connection.status !== 'active' ? (
        <p className="rounded-md bg-bg-inset p-3 text-body-sm text-text-secondary">
          {connection.statusReason}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Connection</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <dl className="flex flex-col gap-2">
              <Row label="MCP server URL">
                {connection.mcpUrl ? (
                  <code className="break-all font-mono">{connection.mcpUrl}</code>
                ) : (
                  'Public URL not configured'
                )}
              </Row>
              <Row label="Mailbox">{connection.mailbox}</Row>
              <Row label="MCP username">{connection.enrollment.username ?? '—'}</Row>
              <Row label="Setup credential">{enrollmentLabel(connection.enrollment)}</Row>
              <Row label="Created">{formatDateTime(connection.createdAt)}</Row>
              <Row label="Last authorized">{formatEventDate(connection.lastAuthorizedAt)}</Row>
              <Row label="Last activity">{formatEventDate(connection.lastUsedAt)}</Row>
              <Row label="Expires">{formatEventDate(connection.expiresAt, 'Never')}</Row>
              <Row label="Live authorizations">{connection.activeGrantCount}</Row>
            </dl>
            {!revoked ? (
              <div className="flex flex-wrap gap-2">
                {mcpUrl ? <CopyButton value={mcpUrl} label="Copy URL" /> : null}
                {mcpUrl ? (
                  <CopyButton
                    value={buildMcpSetupInstructionsText({ mcpUrl, mailbox: connection.mailbox })}
                    label="Copy setup instructions"
                  />
                ) : null}
                <Button size="sm" onClick={() => setPending('reissue')}>
                  <KeyRound aria-hidden="true" />
                  Reissue setup credentials
                </Button>
                <Button size="sm" onClick={() => setPending('rotate')}>
                  <RotateCcw aria-hidden="true" />
                  Rotate credentials
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Mailbox credential &amp; diagnostics</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <dl className="flex flex-col gap-2">
              <Row label="IMAP/SMTP credential">
                <StatusBadge status={health.status} label={health.label} />
              </Row>
              <Row label="Provisioned">
                {formatEventDate(connection.binding.credentialProvisionedAt, 'Not provisioned')}
              </Row>
              <Row label="Last verified">{formatEventDate(connection.binding.lastVerifiedAt)}</Row>
              {connection.binding.lastError ? (
                <Row label="Last error">{connection.binding.lastError}</Row>
              ) : null}
            </dl>
            {!revoked ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  pending={test.isPending}
                  onClick={() =>
                    test.mutate(undefined, {
                      onSuccess: (response) => setTestResult(response.result),
                      onError: (err) => toast.error(message(err, 'The test could not run.')),
                    })
                  }
                >
                  <FlaskConical aria-hidden="true" />
                  Test IMAP &amp; SMTP
                </Button>
                <Button size="sm" onClick={() => setProvisionOpen(true)}>
                  <RefreshCw aria-hidden="true" />
                  Update mailbox credential
                </Button>
              </div>
            ) : null}
            {testResult ? (
              <ul className="flex flex-col gap-1 text-body-sm" aria-live="polite">
                <li>
                  <StatusBadge
                    status={testResult.imap.ok ? 'healthy' : 'critical'}
                    label={`IMAP: ${testResult.imap.ok ? 'OK' : 'Failed'}`}
                  />{' '}
                  {testResult.imap.message}
                  {testResult.imap.folderCount !== null
                    ? ` (${testResult.imap.folderCount} folders)`
                    : ''}
                </li>
                <li>
                  <StatusBadge
                    status={testResult.smtp.ok ? 'healthy' : 'critical'}
                    label={`SMTP: ${testResult.smtp.ok ? 'OK' : 'Failed'}`}
                  />{' '}
                  {testResult.smtp.message}
                </li>
              </ul>
            ) : null}
          </CardContent>
        </Card>
      </div>

      {!revoked ? (
        <Card>
          <CardHeader>
            <CardTitle>Permissions</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-body-sm text-text-secondary">
              Changes apply to the very next request, including from tokens issued before the
              change.
            </p>
            {MCP_SCOPES.map((scope) => (
              <div key={scope} className="flex items-center justify-between gap-3">
                <Label htmlFor={`mcp-perm-${scope}`} className="font-normal">
                  {MCP_SCOPE_LABELS[scope]}
                </Label>
                <Switch
                  id={`mcp-perm-${scope}`}
                  checked={scopes.includes(scope)}
                  onCheckedChange={(on) =>
                    setScopes((current) =>
                      on
                        ? MCP_SCOPES.filter((s) => s === scope || current.includes(s))
                        : current.filter((s) => s !== scope),
                    )
                  }
                />
              </div>
            ))}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mcp-identities">Additional sender identities</Label>
              <Input
                id="mcp-identities"
                placeholder="info@example.com"
                value={identities}
                onChange={(e) => setIdentities(e.target.value)}
              />
              <p className="text-caption text-text-muted">
                Comma-separated aliases this connection may send as. Each must be an alias that
                delivers to {connection.mailbox}.
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="primary"
                pending={update.isPending}
                disabled={scopes.length === 0}
                onClick={() =>
                  update.mutate(
                    {
                      ...(scopesChanged ? { permissions: scopes } : {}),
                      senderIdentities: identities
                        .split(',')
                        .map((s) => s.trim())
                        .filter((s) => s.length > 0),
                    },
                    {
                      onSuccess: () => toast.success('Connection updated.'),
                      onError: (err) =>
                        toast.error(message(err, 'Could not update the connection.')),
                    },
                  )
                }
              >
                Save changes
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Authorizations</CardTitle>
        </CardHeader>
        <CardContent>
          {connection.grants.length === 0 ? (
            <p className="text-body-sm text-text-muted">
              Nobody has authorized this connection yet.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border-subtle">
              {connection.grants.map((grant) => (
                <li
                  key={grant.id}
                  className="flex flex-col gap-1 py-2 text-body-sm sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-text-primary">
                      {grant.clientName ?? 'Unnamed client'}{' '}
                      <span className="text-text-muted">→ {grant.redirectHost}</span>
                    </p>
                    <p className="text-caption text-text-muted">
                      Authorized {formatDateTime(grant.createdAt)} · last used{' '}
                      {formatEventDate(grant.lastUsedAt)} ·{' '}
                      {grant.scopes.map((s) => MCP_SCOPE_LABELS[s]).join(', ')}
                    </p>
                    {grant.revokedAt ? (
                      <p className="text-caption text-status-critical-fg">
                        Revoked {formatDateTime(grant.revokedAt)}
                        {grant.revokedReason ? ` — ${grant.revokedReason}` : ''}
                      </p>
                    ) : null}
                  </div>
                  {grant.revokedAt === null ? (
                    <Button size="sm" variant="ghost" onClick={() => setGrantToRevoke(grant.id)}>
                      Revoke
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Security events</CardTitle>
        </CardHeader>
        <CardContent>
          {audit.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <EventList events={audit.data?.events ?? []} empty="No events recorded." />
          )}
        </CardContent>
      </Card>

      {/* Update mailbox credential */}
      <Dialog
        open={provisionOpen}
        onOpenChange={(next) => {
          setProvisionOpen(next);
          if (!next) setMailboxPassword('');
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Update mailbox credential</DialogTitle>
            <DialogDescription>
              Enter the current IMAP/SMTP password of {connection.mailbox}. It is verified against
              the mail server and stored encrypted in the MCP service only. Applies to every
              connection for this mailbox.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mcp-provision-password">Mailbox password</Label>
            <Input
              id="mcp-provision-password"
              type="password"
              autoComplete="off"
              value={mailboxPassword}
              onChange={(e) => setMailboxPassword(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setProvisionOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={mailboxPassword.length === 0}
              pending={provision.isPending}
              onClick={() =>
                provision.mutate(mailboxPassword, {
                  onSuccess: () => {
                    toast.success('Credential verified and stored.');
                    setMailboxPassword('');
                    setProvisionOpen(false);
                  },
                  onError: (err) => toast.error(message(err, 'Could not update the credential.')),
                })
              }
            >
              Verify and store
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={pending === 'disable'}
        onOpenChange={(open) => !open && setPending(null)}
        tier={2}
        title="Disable connection"
        description="Every request with this connection's tokens is refused until you enable it again. Authorizations are kept."
        confirmLabel="Disable"
        destructive
        pending={setState.isPending}
        onConfirm={() =>
          setState.mutate(
            { action: 'disable' },
            {
              onSuccess: () => {
                setPending(null);
                toast.success('Connection disabled.');
              },
              onError: (err) => toast.error(message(err, 'Could not disable.')),
            },
          )
        }
      />
      <ConfirmDialog
        open={pending === 'reissue'}
        onOpenChange={(open) => !open && setPending(null)}
        tier={2}
        title="Reissue setup credentials"
        description="Generates a new one-time setup password for the same MCP username. Any unused previous setup password stops working. Existing authorizations are kept."
        confirmLabel="Reissue"
        pending={reissue.isPending}
        onConfirm={() => reissue.mutate(undefined, issueCallbacks)}
      />
      <ConfirmDialog
        open={pending === 'rotate'}
        onOpenChange={(open) => !open && setPending(null)}
        tier={2}
        title="Rotate credentials"
        description="Revokes every authorization and token for this connection and issues a new MCP username and setup password. The mailbox owner must connect again."
        confirmLabel="Rotate"
        destructive
        pending={rotate.isPending}
        onConfirm={() => rotate.mutate(undefined, issueCallbacks)}
      />
      <ConfirmDialog
        open={pending === 'revoke'}
        onOpenChange={(open) => !open && setPending(null)}
        tier={3}
        title="Revoke connection"
        description="Permanently revokes this connection: every token stops working immediately and it can never be re-enabled."
        resourceName={connection.mailbox}
        impactSummary={
          <p>
            {connection.activeGrantCount} live authorization(s) for{' '}
            <strong>{connection.mailbox}</strong> will be revoked. The mailbox and its mail are not
            touched.
          </p>
        }
        confirmLabel="Revoke"
        destructive
        pending={setState.isPending}
        onConfirm={() =>
          setState.mutate(
            { action: 'revoke' },
            {
              onSuccess: () => {
                setPending(null);
                toast.success('Connection revoked.');
              },
              onError: (err) => toast.error(message(err, 'Could not revoke.')),
            },
          )
        }
      />
      <ConfirmDialog
        open={pending === 'delete'}
        onOpenChange={(open) => !open && setPending(null)}
        tier={3}
        title="Delete connection record"
        description="Removes this connection's record. Any remaining access is revoked first. The mailbox itself is never deleted."
        resourceName={connection.mailbox}
        impactSummary={
          <p>
            The mailbox {connection.mailbox} and its mail are untouched. MCP security events remain
            in the audit trail.
          </p>
        }
        confirmLabel="Delete"
        destructive
        pending={remove.isPending}
        onConfirm={() =>
          remove.mutate(undefined, {
            onSuccess: () => {
              toast.success('Connection deleted.');
              navigate('/mail/mcp', { replace: true });
            },
            onError: (err) => toast.error(message(err, 'Could not delete.')),
          })
        }
      />
      <ConfirmDialog
        open={grantToRevoke !== null}
        onOpenChange={(open) => !open && setGrantToRevoke(null)}
        tier={2}
        title="Revoke authorization"
        description="That client's tokens stop working immediately. Other authorizations for this connection are unaffected."
        confirmLabel="Revoke"
        destructive
        pending={revokeGrant.isPending}
        onConfirm={() =>
          grantToRevoke &&
          revokeGrant.mutate(grantToRevoke, {
            onSuccess: () => {
              setGrantToRevoke(null);
              toast.success('Authorization revoked.');
            },
            onError: (err) => toast.error(message(err, 'Could not revoke the authorization.')),
          })
        }
      />

      <OneTimeCredentialDialog
        title="New setup credentials"
        credential={issued?.oneTimeCredential ?? null}
        mailbox={connection.mailbox}
        mcpUrl={connection.mcpUrl}
        permissions={connection.permissions}
        onClose={() => setIssued(null)}
      />
    </div>
  );
}
