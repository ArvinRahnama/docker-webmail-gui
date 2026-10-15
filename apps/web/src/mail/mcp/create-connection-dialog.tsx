/**
 * "Generate MCP connection" — the central postmaster interaction.
 *
 * Picks an existing mailbox, sets the connection's permissions (Read, Send
 * and Delete on by default for this feature, each switchable), provisions the
 * mailbox's IMAP/SMTP credential when apps/mcp does not already hold a
 * verified one, and chooses an expiry. On success the one-time setup
 * credential is handed to `onCreated` — this component never stores it.
 */
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import {
  MCP_SCOPE_LABELS,
  MCP_SCOPES,
  type CreateMcpConnectionResponse,
  type McpScope,
} from '@dwg/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { StatusBadge } from '@/components/status/status-badge';
import { ApiError } from '@/lib/api-client';
import { useMailboxesQuery } from '@/mail/use-mail-queries';
import {
  useCreateMcpConnectionMutation,
  useMcpMailboxOverviewQuery,
  useMcpSettingsQuery,
} from './use-mcp-queries';
import { CREDENTIAL_HEALTH_DISPLAY } from './mcp-ui';

const SELECT_CLASS =
  'h-9 w-full rounded-sm border border-border-default bg-bg-surface px-3 text-body-sm text-text-primary';

const SCOPE_WARNINGS: Partial<Record<McpScope, string>> = {
  'mail.send': 'The AI client will be able to send email as this mailbox.',
  'mail.delete':
    'The AI client will be able to move messages to Trash (recoverable; never permanent deletion).',
};

export interface CreateConnectionDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Pre-selects a mailbox (from the mailbox detail page). */
  readonly initialMailbox?: string | undefined;
  readonly onCreated: (response: CreateMcpConnectionResponse) => void;
}

type ExpiryChoice = 'default' | 'never' | '30' | '90' | '365';

export function CreateConnectionDialog({
  open,
  onOpenChange,
  initialMailbox,
  onCreated,
}: CreateConnectionDialogProps) {
  const [search, setSearch] = useState('');
  const [mailbox, setMailbox] = useState(initialMailbox ?? '');
  const [label, setLabel] = useState('');
  const [scopes, setScopes] = useState<McpScope[]>([...MCP_SCOPES]);
  const [password, setPassword] = useState('');
  const [replaceCredential, setReplaceCredential] = useState(false);
  const [expiry, setExpiry] = useState<ExpiryChoice>('default');
  const [error, setError] = useState<string | null>(null);

  const settings = useMcpSettingsQuery(open);
  const mailboxes = useMailboxesQuery({ pageSize: 50, ...(search ? { search } : {}) });
  const overview = useMcpMailboxOverviewQuery(mailbox, open && mailbox.length > 0);
  const mutation = useCreateMcpConnectionMutation();

  useEffect(() => {
    if (open) {
      setMailbox(initialMailbox ?? '');
      setLabel(initialMailbox ? `ChatGPT — ${initialMailbox}` : '');
      setScopes([...MCP_SCOPES]);
      setPassword('');
      setReplaceCredential(false);
      setExpiry('default');
      setError(null);
    }
  }, [open, initialMailbox]);

  const healthy = overview.data?.binding?.credentialHealth === 'healthy';
  const needsPassword = !healthy || replaceCredential;
  const defaultExpiryDays = settings.data?.settings.connectionExpiryDays ?? null;
  const serviceEnabled = settings.data?.settings.enabled ?? false;

  const mailboxOptions = useMemo(() => {
    const list = (mailboxes.data?.mailboxes ?? []).map((m) => m.email);
    if (mailbox && !list.includes(mailbox)) list.unshift(mailbox);
    return list;
  }, [mailboxes.data, mailbox]);

  function toggleScope(scope: McpScope, on: boolean) {
    setScopes((current) =>
      on
        ? MCP_SCOPES.filter((s) => s === scope || current.includes(s))
        : current.filter((s) => s !== scope),
    );
  }

  function submit() {
    setError(null);
    if (!mailbox) return setError('Choose a mailbox.');
    if (!label.trim())
      return setError('Give the connection a label so you can recognise it later.');
    if (scopes.length === 0) return setError('Enable at least one permission.');
    if (needsPassword && password.length === 0) {
      return setError(
        'Enter the mailbox’s current IMAP/SMTP password so it can be verified and stored encrypted.',
      );
    }
    const expiresInDays =
      expiry === 'default' ? undefined : expiry === 'never' ? null : Number(expiry);
    mutation.mutate(
      {
        mailbox,
        label: label.trim(),
        permissions: scopes,
        ...(expiresInDays !== undefined ? { expiresInDays } : {}),
        ...(needsPassword ? { mailboxPassword: password } : {}),
      },
      {
        onSuccess: (response) => {
          setPassword('');
          onOpenChange(false);
          onCreated(response);
        },
        onError: (err) =>
          setError(err instanceof ApiError ? err.message : 'Could not generate the connection.'),
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setPassword('');
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Generate MCP connection</DialogTitle>
          <DialogDescription>
            Issues a unique MCP URL and one-time setup credentials for one mailbox. The mailbox
            owner uses them to authorize a compatible AI client such as ChatGPT. Their email
            password is never given to the AI client.
          </DialogDescription>
        </DialogHeader>

        {!serviceEnabled && settings.data ? (
          <p
            role="alert"
            className="rounded-md bg-status-warning-bg p-3 text-body-sm text-status-warning-fg"
          >
            MCP is disabled. Enable it in Service settings before generating connections.
          </p>
        ) : null}

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mcp-create-mailbox">Mailbox</Label>
            {initialMailbox ? null : (
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search mailboxes…"
                aria-label="Search mailboxes"
              />
            )}
            <select
              id="mcp-create-mailbox"
              className={SELECT_CLASS}
              value={mailbox}
              onChange={(event) => {
                setMailbox(event.target.value);
                if (!label || label.startsWith('ChatGPT — '))
                  setLabel(event.target.value ? `ChatGPT — ${event.target.value}` : '');
              }}
              disabled={initialMailbox !== undefined}
            >
              <option value="">Choose a mailbox…</option>
              {mailboxOptions.map((email) => (
                <option key={email} value={email}>
                  {email}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mcp-create-label">Connection label</Label>
            <Input
              id="mcp-create-label"
              value={label}
              maxLength={80}
              onChange={(event) => setLabel(event.target.value)}
            />
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-body-sm font-medium text-text-primary">Permissions</legend>
            {MCP_SCOPES.map((scope) => (
              <div
                key={scope}
                className="flex flex-col gap-1 rounded-md border border-border-subtle p-2.5"
              >
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor={`mcp-create-${scope}`} className="font-normal">
                    {MCP_SCOPE_LABELS[scope]}
                  </Label>
                  <Switch
                    id={`mcp-create-${scope}`}
                    checked={scopes.includes(scope)}
                    onCheckedChange={(on) => toggleScope(scope, on)}
                  />
                </div>
                {scopes.includes(scope) && SCOPE_WARNINGS[scope] ? (
                  <p className="flex items-start gap-1.5 text-caption text-status-warning-fg">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                    {SCOPE_WARNINGS[scope]}
                  </p>
                ) : null}
              </div>
            ))}
          </fieldset>

          {mailbox ? (
            <div className="flex flex-col gap-2 rounded-md border border-border-subtle p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-body-sm font-medium text-text-primary">
                  IMAP/SMTP credential
                </span>
                {overview.data?.binding ? (
                  <StatusBadge
                    status={
                      CREDENTIAL_HEALTH_DISPLAY[overview.data.binding.credentialHealth].status
                    }
                    label={CREDENTIAL_HEALTH_DISPLAY[overview.data.binding.credentialHealth].label}
                  />
                ) : (
                  <StatusBadge status="unknown" label="Not provisioned" />
                )}
              </div>
              <p className="text-caption text-text-secondary">
                The MCP service logs in to IMAP/SMTP as this mailbox with its own password, stored
                encrypted (AES-256-GCM) in the MCP service only. It is verified against the mail
                server before anything is stored, and never shown again.
              </p>
              {healthy ? (
                <div className="flex items-center gap-2">
                  <Switch
                    id="mcp-create-replace"
                    checked={replaceCredential}
                    onCheckedChange={setReplaceCredential}
                  />
                  <Label htmlFor="mcp-create-replace" className="text-body-sm font-normal">
                    Replace the stored credential
                  </Label>
                </div>
              ) : null}
              {needsPassword ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="mcp-create-password">Mailbox password</Label>
                  <Input
                    id="mcp-create-password"
                    type="password"
                    autoComplete="off"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mcp-create-expiry">Connection expiry</Label>
            <select
              id="mcp-create-expiry"
              className={SELECT_CLASS}
              value={expiry}
              onChange={(event) => setExpiry(event.target.value as ExpiryChoice)}
            >
              <option value="default">
                Service default (
                {defaultExpiryDays === null ? 'never expires' : `${defaultExpiryDays} days`})
              </option>
              <option value="never">Never expires</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
              <option value="365">365 days</option>
            </select>
            <p className="text-caption text-text-muted">
              The setup password itself expires after{' '}
              {settings.data?.settings.setupCredentialTtlHours ?? 24} hours and works once.
            </p>
          </div>

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
          <Button
            type="button"
            variant="primary"
            pending={mutation.isPending}
            disabled={!serviceEnabled}
            onClick={submit}
          >
            Generate connection
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
