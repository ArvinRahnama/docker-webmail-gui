import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft } from 'lucide-react';
import { NewPasswordSchema } from '@dwg/shared';
import type { MailboxRestrictScope } from '@dwg/shared';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Badge } from '@/components/ui/badge';
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
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/page-header';
import { PasswordField } from '@/components/password-field';
import { Skeleton } from '@/components/ui/skeleton';
import { UnsupportedNotice } from '@/components/unsupported-notice';
import { ApiClientError, ApiError } from '@/lib/api-client';
import { formatBytes, formatPercent, formatQuota } from '@/lib/format';
import {
  useChangeMailboxPasswordMutation,
  useClearMailboxQuotaMutation,
  useDeleteMailboxMutation,
  useMailCapabilitiesQuery,
  useMailboxDetailQuery,
  useRestrictMailboxMutation,
  useSetMailboxQuotaMutation,
} from './use-mail-queries';

export function MailboxDetailPage() {
  const { address = '' } = useParams<{ address: string }>();
  const navigate = useNavigate();
  const capabilities = useMailCapabilitiesQuery();
  const query = useMailboxDetailQuery(address);

  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const [quotaDialogOpen, setQuotaDialogOpen] = useState(false);
  const [quotaValue, setQuotaValue] = useState('');

  const [restrictAction, setRestrictAction] = useState<{
    scope: MailboxRestrictScope;
    restricted: boolean;
  } | null>(null);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [mailDataChoice, setMailDataChoice] = useState<'delete' | 'keep' | null>(null);

  const changePasswordMutation = useChangeMailboxPasswordMutation();
  const setQuotaMutation = useSetMailboxQuotaMutation();
  const clearQuotaMutation = useClearMailboxQuotaMutation();
  const restrictMutation = useRestrictMailboxMutation();
  const deleteMutation = useDeleteMailboxMutation();

  const canManage = capabilities.data?.localAccountManagement.supported ?? true;
  const canManageQuotas = capabilities.data?.quotas.supported ?? true;

  if (query.isError) {
    return (
      <ErrorState
        message="Could not load this mailbox."
        errorId={
          query.error instanceof ApiError || query.error instanceof ApiClientError
            ? query.error.errorId
            : 'unknown'
        }
        onRetry={() => void query.refetch()}
      />
    );
  }

  if (query.isLoading || !query.data) {
    return <Skeleton className="h-64 w-full" />;
  }

  const { mailbox, usage, dependentAliases } = query.data;

  return (
    <div className="flex flex-col gap-6">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => navigate('/mail/mailboxes')}
        className="w-fit"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        Back to mailboxes
      </Button>

      <PageHeader
        title={mailbox.email}
        description={`Domain: ${mailbox.domain}`}
        action={
          canManage ? (
            <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
              Delete mailbox
            </Button>
          ) : undefined
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

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Status</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              {mailbox.restricted.send ? <Badge variant="outline">Send restricted</Badge> : null}
              {mailbox.restricted.receive ? (
                <Badge variant="outline">Receive restricted</Badge>
              ) : null}
              {!mailbox.restricted.send && !mailbox.restricted.receive ? (
                <span className="text-body-sm text-text-secondary">No restrictions in effect.</span>
              ) : null}
            </div>
            {canManage ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    setRestrictAction({ scope: 'send', restricted: !mailbox.restricted.send })
                  }
                >
                  {mailbox.restricted.send ? 'Allow sending' : 'Restrict sending'}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    setRestrictAction({ scope: 'receive', restricted: !mailbox.restricted.receive })
                  }
                >
                  {mailbox.restricted.receive ? 'Allow receiving' : 'Restrict receiving'}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setPasswordDialogOpen(true)}>
                  Change password
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Quota</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {canManageQuotas ? (
              <>
                <p className="text-body-sm text-text-primary">
                  Limit: <strong>{formatQuota(mailbox.quota)}</strong>
                </p>
                {usage?.available ? (
                  <p className="text-body-sm text-text-secondary">
                    Used: {formatBytes(usage.storageBytesUsed)}
                    {usage.storageBytesLimit !== null
                      ? ` of ${formatBytes(usage.storageBytesLimit)} (${formatPercent(
                          usage.storageBytesLimit > 0
                            ? (usage.storageBytesUsed ?? 0) / usage.storageBytesLimit
                            : null,
                        )})`
                      : null}
                  </p>
                ) : (
                  <p className="text-body-sm text-text-muted">Usage: Unknown</p>
                )}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setQuotaValue(mailbox.quota ?? '');
                      setQuotaDialogOpen(true);
                    }}
                  >
                    Set quota
                  </Button>
                  {mailbox.quota ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      pending={clearQuotaMutation.isPending}
                      onClick={() =>
                        clearQuotaMutation.mutate(mailbox.email, {
                          onSuccess: () => toast.success('Quota cleared.'),
                          onError: (err) =>
                            toast.error(
                              err instanceof ApiError ? err.message : 'Could not clear quota.',
                            ),
                        })
                      }
                    >
                      Clear
                    </Button>
                  ) : null}
                </div>
              </>
            ) : (
              <UnsupportedNotice
                reason={
                  capabilities.data?.quotas.reason ?? 'Quotas are unsupported on this deployment.'
                }
              />
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Aliases pointing here</CardTitle>
        </CardHeader>
        <CardContent>
          {dependentAliases.length === 0 ? (
            <EmptyState
              variant="first-run"
              title="No aliases point at this mailbox"
              description="Nothing forwards to this address yet."
            />
          ) : (
            <ul className="flex flex-col gap-1.5">
              {dependentAliases.map((alias) => (
                <li key={alias.id} className="text-body-sm">
                  <button
                    type="button"
                    onClick={() => navigate('/mail/aliases')}
                    className="text-accent hover:underline"
                  >
                    {alias.address}
                  </button>
                  <span className="text-text-muted"> ({alias.type})</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Change password */}
      <Dialog
        open={passwordDialogOpen}
        onOpenChange={(next) => {
          setPasswordDialogOpen(next);
          if (!next) {
            setNewPassword('');
            setConfirmPassword('');
            setPasswordError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change password</DialogTitle>
            <DialogDescription>
              Sets a new password for {mailbox.email}. The current password is never shown or
              required here — an administrator does not need to know it to reset it.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <PasswordField
              label="New password"
              value={newPassword}
              onChange={setNewPassword}
              autoComplete="new-password"
              autoFocus
            />
            <PasswordField
              label="Confirm new password"
              value={confirmPassword}
              onChange={setConfirmPassword}
              autoComplete="new-password"
              allowGenerate={false}
              showStrength={false}
            />
            {passwordError ? (
              <p role="alert" className="text-body-sm text-status-critical-fg">
                {passwordError}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setPasswordDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              pending={changePasswordMutation.isPending}
              onClick={() => {
                setPasswordError(null);
                const result = NewPasswordSchema.safeParse(newPassword);
                if (!result.success) {
                  setPasswordError(result.error.issues[0]?.message ?? 'Invalid password.');
                  return;
                }
                if (newPassword !== confirmPassword) {
                  setPasswordError('Passwords do not match.');
                  return;
                }
                changePasswordMutation.mutate(
                  { address: mailbox.email, password: newPassword },
                  {
                    onSuccess: () => {
                      toast.success('Password changed.');
                      setPasswordDialogOpen(false);
                      setNewPassword('');
                      setConfirmPassword('');
                    },
                    onError: (err) =>
                      setPasswordError(
                        err instanceof ApiError ? err.message : 'Could not change the password.',
                      ),
                  },
                );
              }}
            >
              Change password
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Set quota */}
      <Dialog open={quotaDialogOpen} onOpenChange={setQuotaDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set quota</DialogTitle>
            <DialogDescription>e.g. 500M, 2G.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mailbox-quota-value">Quota</Label>
            <Input
              id="mailbox-quota-value"
              value={quotaValue}
              onChange={(event) => setQuotaValue(event.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setQuotaDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              pending={setQuotaMutation.isPending}
              disabled={quotaValue.length === 0}
              onClick={() =>
                setQuotaMutation.mutate(
                  { address: mailbox.email, quota: quotaValue },
                  {
                    onSuccess: () => {
                      toast.success('Quota updated.');
                      setQuotaDialogOpen(false);
                    },
                    onError: (err) =>
                      toast.error(
                        err instanceof ApiError ? err.message : 'Could not set the quota.',
                      ),
                  },
                )
              }
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={restrictAction !== null}
        onOpenChange={(next) => {
          if (!next) setRestrictAction(null);
        }}
        tier={2}
        title={restrictAction?.restricted ? 'Restrict mailbox' : 'Remove restriction'}
        description={
          restrictAction?.restricted
            ? `Mail ${restrictAction.scope === 'send' ? 'sent from' : 'delivered to'} ${mailbox.email} will be blocked until this restriction is removed. IMAP/POP3 login is unaffected.`
            : `${mailbox.email} will be able to ${restrictAction?.scope === 'send' ? 'send' : 'receive'} mail again.`
        }
        destructive={restrictAction?.restricted ?? false}
        pending={restrictMutation.isPending}
        onConfirm={() => {
          if (!restrictAction) return;
          restrictMutation.mutate(
            {
              address: mailbox.email,
              scope: restrictAction.scope,
              restricted: restrictAction.restricted,
            },
            {
              onSuccess: () => {
                toast.success('Restriction updated.');
                setRestrictAction(null);
              },
              onError: (err) =>
                toast.error(
                  err instanceof ApiError ? err.message : 'Could not update the restriction.',
                ),
            },
          );
        }}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={(next) => {
          setDeleteOpen(next);
          if (!next) setMailDataChoice(null);
        }}
        tier={3}
        title="Delete mailbox"
        description="This permanently removes the account. There is no trash."
        destructive
        resourceName={mailbox.email}
        pending={deleteMutation.isPending}
        impactSummary={
          <div className="flex flex-col gap-3">
            <p>
              Deletes <strong>{mailbox.email}</strong>.{' '}
              {dependentAliases.length > 0
                ? `${dependentAliases.length} alias(es) currently point at this address and will lose that recipient.`
                : 'No aliases point at this address.'}
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
                  name="mail-data-choice-detail"
                  checked={mailDataChoice === 'keep'}
                  onChange={() => setMailDataChoice('keep')}
                />
                Delete account, keep mail on disk
              </label>
              <label className="flex items-center gap-2 text-body-sm">
                <input
                  type="radio"
                  name="mail-data-choice-detail"
                  checked={mailDataChoice === 'delete'}
                  onChange={() => setMailDataChoice('delete')}
                />
                Delete account and its mail
              </label>
            </fieldset>
          </div>
        }
        onConfirm={() => {
          if (!mailDataChoice) {
            toast.error('Choose whether to keep or delete the mail data before confirming.');
            return;
          }
          deleteMutation.mutate(
            { address: mailbox.email, mailData: mailDataChoice },
            {
              onSuccess: () => {
                toast.success(`${mailbox.email} deleted.`);
                navigate('/mail/mailboxes', { replace: true });
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
