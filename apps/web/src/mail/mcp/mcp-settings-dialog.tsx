/**
 * Global MCP service configuration — enable/disable, public HTTPS endpoint,
 * IMAP/SMTP transport, credential/connection lifetimes, default permissions,
 * limits, retention and client-registration policy — plus the OAuth
 * discovery check. Every value is validated again server-side against the
 * shared schema; this form is a convenience, not the control.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import {
  MCP_SCOPE_LABELS,
  MCP_SCOPES,
  McpSettingsSchema,
  type McpDiscoveryCheckResponse,
  type McpSettings,
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
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api-client';
import { toast } from 'sonner';
import {
  useMcpDiscoveryCheckMutation,
  useMcpSettingsQuery,
  useUpdateMcpSettingsMutation,
} from './use-mcp-queries';

const SELECT_CLASS =
  'h-9 w-full rounded-sm border border-border-default bg-bg-surface px-3 text-body-sm text-text-primary';

function NumberField({
  id,
  label,
  value,
  onChange,
  min,
  max,
  hint,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        value={Number.isFinite(value) ? value : ''}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {hint ? <p className="text-caption text-text-muted">{hint}</p> : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-3 rounded-md border border-border-subtle p-3">
      <legend className="px-1 text-body-sm font-semibold text-text-primary">{title}</legend>
      {children}
    </fieldset>
  );
}

export function McpSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const query = useMcpSettingsQuery(open);
  const mutation = useUpdateMcpSettingsMutation();
  const discovery = useMcpDiscoveryCheckMutation();
  const [draft, setDraft] = useState<McpSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checks, setChecks] = useState<McpDiscoveryCheckResponse | null>(null);

  useEffect(() => {
    if (open && query.data) setDraft(query.data.settings);
    if (!open) {
      setError(null);
      setChecks(null);
    }
  }, [open, query.data]);

  const set = <K extends keyof McpSettings>(key: K, value: McpSettings[K]) =>
    setDraft((d) => (d === null ? d : { ...d, [key]: value }));

  function save() {
    if (draft === null) return;
    setError(null);
    const parsed = McpSettingsSchema.safeParse({
      ...draft,
      publicBaseUrl: draft.publicBaseUrl === '' ? null : draft.publicBaseUrl,
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError(`${issue?.path.join('.') ?? 'settings'}: ${issue?.message ?? 'invalid value'}`);
      return;
    }
    mutation.mutate(parsed.data, {
      onSuccess: () => {
        toast.success('MCP settings saved.');
        onOpenChange(false);
      },
      onError: (err) =>
        setError(err instanceof ApiError ? err.message : 'Could not save the settings.'),
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>MCP service settings</DialogTitle>
          <DialogDescription>
            Applies to every MCP connection. Changes take effect on the next request.
          </DialogDescription>
        </DialogHeader>

        {draft === null ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <div className="flex flex-col gap-4">
            {query.data && query.data.warnings.length > 0 ? (
              <ul
                role="note"
                className="flex flex-col gap-1 rounded-md bg-status-warning-bg p-3 text-body-sm text-status-warning-fg"
              >
                {query.data.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}

            <Section title="Service">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <Label htmlFor="mcp-enabled">Enable MCP</Label>
                  <p className="text-caption text-text-muted">
                    When off, every MCP and OAuth endpoint refuses requests and existing tokens stop
                    working.
                  </p>
                </div>
                <Switch
                  id="mcp-enabled"
                  checked={draft.enabled}
                  onCheckedChange={(on) => set('enabled', on)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mcp-public-url">Public HTTPS endpoint</Label>
                <Input
                  id="mcp-public-url"
                  placeholder="https://mcp.example.com"
                  value={draft.publicBaseUrl ?? ''}
                  onChange={(event) => set('publicBaseUrl', event.target.value)}
                />
                <p className="text-caption text-text-muted">
                  The origin your reverse proxy serves the MCP listener on. Changing it invalidates
                  every issued token.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  pending={discovery.isPending}
                  onClick={() =>
                    discovery.mutate(undefined, {
                      onSuccess: setChecks,
                      onError: (err) =>
                        toast.error(
                          err instanceof ApiError ? err.message : 'Discovery check failed.',
                        ),
                    })
                  }
                >
                  Validate OAuth discovery
                </Button>
                <span className="text-caption text-text-muted">
                  Checks the saved settings, not unsaved edits.
                </span>
              </div>
              {checks ? (
                <ul className="flex flex-col gap-1 text-body-sm">
                  {checks.checks.map((check) => (
                    <li key={check.check} className="flex items-start gap-2">
                      {check.ok ? (
                        <CheckCircle2
                          className="mt-0.5 size-4 shrink-0 text-status-healthy-fg"
                          aria-label="Passed"
                        />
                      ) : (
                        <XCircle
                          className="mt-0.5 size-4 shrink-0 text-status-critical-fg"
                          aria-label="Failed"
                        />
                      )}
                      <span>{check.message}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </Section>

            <Section title="Mail server (IMAP/SMTP)">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <Label htmlFor="mcp-imap-host">IMAP host</Label>
                  <Input
                    id="mcp-imap-host"
                    value={draft.mail.imapHost}
                    onChange={(e) => set('mail', { ...draft.mail, imapHost: e.target.value })}
                  />
                </div>
                <NumberField
                  id="mcp-imap-port"
                  label="IMAP port"
                  min={1}
                  max={65535}
                  value={draft.mail.imapPort}
                  onChange={(v) => set('mail', { ...draft.mail, imapPort: v })}
                />
                <div className="flex flex-col gap-1.5 sm:col-span-3">
                  <Label htmlFor="mcp-imap-sec">IMAP security</Label>
                  <select
                    id="mcp-imap-sec"
                    className={SELECT_CLASS}
                    value={draft.mail.imapSecurity}
                    onChange={(e) =>
                      set('mail', {
                        ...draft.mail,
                        imapSecurity: e.target.value === 'starttls' ? 'starttls' : 'tls',
                      })
                    }
                  >
                    <option value="tls">Implicit TLS (usually 993)</option>
                    <option value="starttls">Required STARTTLS (usually 143)</option>
                  </select>
                </div>
                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <Label htmlFor="mcp-smtp-host">SMTP host</Label>
                  <Input
                    id="mcp-smtp-host"
                    value={draft.mail.smtpHost}
                    onChange={(e) => set('mail', { ...draft.mail, smtpHost: e.target.value })}
                  />
                </div>
                <NumberField
                  id="mcp-smtp-port"
                  label="SMTP port"
                  min={1}
                  max={65535}
                  value={draft.mail.smtpPort}
                  onChange={(v) => set('mail', { ...draft.mail, smtpPort: v })}
                />
                <div className="flex flex-col gap-1.5 sm:col-span-3">
                  <Label htmlFor="mcp-smtp-sec">SMTP security</Label>
                  <select
                    id="mcp-smtp-sec"
                    className={SELECT_CLASS}
                    value={draft.mail.smtpSecurity}
                    onChange={(e) =>
                      set('mail', {
                        ...draft.mail,
                        smtpSecurity: e.target.value === 'starttls' ? 'starttls' : 'tls',
                      })
                    }
                  >
                    <option value="tls">Implicit TLS (usually 465)</option>
                    <option value="starttls">Required STARTTLS (usually 587)</option>
                  </select>
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mcp-tls-name">Certificate name (optional)</Label>
                <Input
                  id="mcp-tls-name"
                  placeholder="mail.example.com"
                  value={draft.mail.tlsServername ?? ''}
                  onChange={(e) =>
                    set('mail', {
                      ...draft.mail,
                      tlsServername: e.target.value.trim() === '' ? null : e.target.value.trim(),
                    })
                  }
                />
                <p className="text-caption text-text-muted">
                  Verify the mail server certificate against this name when the host above is a
                  container name.
                </p>
              </div>
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="mcp-tls-verify">Verify the mail server certificate</Label>
                <Switch
                  id="mcp-tls-verify"
                  checked={draft.mail.tlsVerify}
                  onCheckedChange={(on) => set('mail', { ...draft.mail, tlsVerify: on })}
                />
              </div>
              {!draft.mail.tlsVerify ? (
                <p role="alert" className="text-caption text-status-critical-fg">
                  Disabling verification lets anyone on the path to the mail server intercept
                  mailbox credentials.
                </p>
              ) : null}
            </Section>

            <Section title="Credentials and connections">
              <div className="grid gap-3 sm:grid-cols-2">
                <NumberField
                  id="mcp-setup-ttl"
                  label="Setup password lifetime (hours)"
                  min={1}
                  max={168}
                  value={draft.setupCredentialTtlHours}
                  onChange={(v) => set('setupCredentialTtlHours', v)}
                />
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="mcp-conn-expiry">Default connection expiry</Label>
                  <select
                    id="mcp-conn-expiry"
                    className={SELECT_CLASS}
                    value={
                      draft.connectionExpiryDays === null
                        ? 'never'
                        : String(draft.connectionExpiryDays)
                    }
                    onChange={(e) =>
                      set(
                        'connectionExpiryDays',
                        e.target.value === 'never' ? null : Number(e.target.value),
                      )
                    }
                  >
                    <option value="never">Never</option>
                    <option value="30">30 days</option>
                    <option value="90">90 days</option>
                    <option value="180">180 days</option>
                    <option value="365">365 days</option>
                  </select>
                </div>
                <NumberField
                  id="mcp-max-conn"
                  label="Connections per mailbox"
                  min={1}
                  max={50}
                  value={draft.maxConnectionsPerMailbox}
                  onChange={(v) => set('maxConnectionsPerMailbox', v)}
                />
                <NumberField
                  id="mcp-audit-days"
                  label="Audit retention (days)"
                  min={7}
                  max={3650}
                  value={draft.auditRetentionDays}
                  onChange={(v) => set('auditRetentionDays', v)}
                />
                <NumberField
                  id="mcp-access-ttl"
                  label="Access token lifetime (minutes)"
                  min={5}
                  max={60}
                  value={draft.accessTokenTtlMinutes}
                  onChange={(v) => set('accessTokenTtlMinutes', v)}
                />
                <NumberField
                  id="mcp-refresh-ttl"
                  label="Refresh token lifetime (days)"
                  min={1}
                  max={365}
                  value={draft.refreshTokenTtlDays}
                  onChange={(v) => set('refreshTokenTtlDays', v)}
                />
              </div>
              <fieldset className="flex flex-col gap-2">
                <legend className="text-body-sm font-medium text-text-primary">
                  Default permissions for new connections
                </legend>
                {MCP_SCOPES.map((scope) => (
                  <div key={scope} className="flex items-center justify-between gap-3">
                    <Label htmlFor={`mcp-default-${scope}`} className="font-normal">
                      {MCP_SCOPE_LABELS[scope]}
                    </Label>
                    <Switch
                      id={`mcp-default-${scope}`}
                      checked={draft.defaultPermissions.includes(scope)}
                      onCheckedChange={(on) =>
                        set(
                          'defaultPermissions',
                          on
                            ? MCP_SCOPES.filter(
                                (s) => s === scope || draft.defaultPermissions.includes(s),
                              )
                            : draft.defaultPermissions.filter((s) => s !== scope),
                        )
                      }
                    />
                  </div>
                ))}
              </fieldset>
            </Section>

            <Section title="Limits">
              <div className="grid gap-3 sm:grid-cols-2">
                <NumberField
                  id="mcp-rl-calls"
                  label="Tool calls per minute"
                  min={1}
                  max={600}
                  value={draft.rateLimits.toolCallsPerMinute}
                  onChange={(v) =>
                    set('rateLimits', { ...draft.rateLimits, toolCallsPerMinute: v })
                  }
                />
                <NumberField
                  id="mcp-rl-rcpt"
                  label="Recipients per message"
                  min={1}
                  max={100}
                  value={draft.rateLimits.maxRecipientsPerMessage}
                  onChange={(v) =>
                    set('rateLimits', { ...draft.rateLimits, maxRecipientsPerMessage: v })
                  }
                />
                <NumberField
                  id="mcp-rl-hour"
                  label="Sends per hour"
                  min={0}
                  max={1000}
                  value={draft.rateLimits.sendsPerHour}
                  onChange={(v) => set('rateLimits', { ...draft.rateLimits, sendsPerHour: v })}
                  hint="0 disables sending for every connection."
                />
                <NumberField
                  id="mcp-rl-day"
                  label="Sends per day"
                  min={0}
                  max={10000}
                  value={draft.rateLimits.sendsPerDay}
                  onChange={(v) => set('rateLimits', { ...draft.rateLimits, sendsPerDay: v })}
                />
                <NumberField
                  id="mcp-max-attach"
                  label="Max attachment size (KB)"
                  min={1}
                  max={25600}
                  value={Math.round(draft.maxAttachmentBytes / 1024)}
                  onChange={(v) => set('maxAttachmentBytes', v * 1024)}
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="mcp-sent-copies">File a copy of sent mail in Sent</Label>
                <Switch
                  id="mcp-sent-copies"
                  checked={draft.saveSentCopies}
                  onCheckedChange={(on) => set('saveSentCopies', on)}
                />
              </div>
            </Section>

            <Section title="OAuth client registration">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="mcp-cimd">Client ID Metadata Documents (used by ChatGPT)</Label>
                <Switch
                  id="mcp-cimd"
                  checked={draft.clientRegistration.metadataDocuments}
                  onCheckedChange={(on) =>
                    set('clientRegistration', {
                      ...draft.clientRegistration,
                      metadataDocuments: on,
                    })
                  }
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="mcp-dcr">Dynamic Client Registration</Label>
                <Switch
                  id="mcp-dcr"
                  checked={draft.clientRegistration.dynamicRegistration}
                  onCheckedChange={(on) =>
                    set('clientRegistration', {
                      ...draft.clientRegistration,
                      dynamicRegistration: on,
                    })
                  }
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mcp-cimd-hosts">Trusted metadata hosts (optional)</Label>
                <Input
                  id="mcp-cimd-hosts"
                  placeholder="chatgpt.com"
                  value={draft.clientRegistration.allowedMetadataHosts.join(', ')}
                  onChange={(e) =>
                    set('clientRegistration', {
                      ...draft.clientRegistration,
                      allowedMetadataHosts: e.target.value
                        .split(',')
                        .map((h) => h.trim())
                        .filter((h) => h.length > 0),
                    })
                  }
                />
                <p className="text-caption text-text-muted">
                  Comma-separated. Empty allows any public HTTPS host (fetched with SSRF
                  protection).
                </p>
              </div>
            </Section>

            {error ? (
              <p role="alert" className="text-body-sm text-status-critical-fg">
                {error}
              </p>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            pending={mutation.isPending}
            disabled={draft === null}
            onClick={save}
          >
            Save settings
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
