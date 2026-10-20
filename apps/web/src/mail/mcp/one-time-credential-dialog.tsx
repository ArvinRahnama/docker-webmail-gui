/**
 * Shows a freshly generated setup credential exactly once.
 *
 * The password lives only in the props of this dialog's open lifetime: the
 * caller holds it in component state, and `onClose` is the caller's cue to
 * drop it. There is no API that can return it again — closing this dialog
 * is final, which the dialog says plainly and asks the postmaster to
 * acknowledge before it can be dismissed.
 */
import { useState } from 'react';
import { AlertTriangle, KeyRound } from 'lucide-react';
import {
  buildMcpConnectionDetailsText,
  buildMcpSetupInstructionsText,
  MCP_SCOPE_LABELS,
  type McpOneTimeCredential,
  type McpScope,
} from '@dwg/shared';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { BreakableText } from '@/components/breakable-text';
import { formatDateTime } from '@/lib/format';
import { CopyButton } from './mcp-ui';

export interface OneTimeCredentialDialogProps {
  readonly credential: McpOneTimeCredential | null;
  readonly mailbox: string;
  readonly mcpUrl: string | null;
  readonly permissions: readonly McpScope[];
  readonly title: string;
  readonly onClose: () => void;
}

function Field({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-caption font-medium text-text-muted">{label}</span>
      <div className="flex flex-wrap items-center gap-2">
        <code
          className={`min-w-0 flex-1 break-all rounded-md border border-border-default bg-bg-inset px-2.5 py-1.5 text-body-sm text-text-primary ${mono ? 'font-mono' : ''}`}
        >
          {value}
        </code>
        <CopyButton value={value} label="Copy" variant="ghost" />
      </div>
    </div>
  );
}

export function OneTimeCredentialDialog({
  credential,
  mailbox,
  mcpUrl,
  permissions,
  title,
  onClose,
}: OneTimeCredentialDialogProps) {
  const [acknowledged, setAcknowledged] = useState(false);
  const open = credential !== null;
  const url = mcpUrl ?? '(public MCP URL not configured)';

  const close = () => {
    setAcknowledged(false);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && acknowledged) close();
      }}
    >
      <DialogContent
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          if (!acknowledged) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-5 text-accent" aria-hidden="true" />
            {title}
          </DialogTitle>
          <DialogDescription>
            Deliver these details to the owner of{' '}
            <strong>
              <BreakableText text={mailbox} />
            </strong>{' '}
            through a channel you trust (in person, or a password manager share).
          </DialogDescription>
        </DialogHeader>

        {credential !== null ? (
          <div className="flex flex-col gap-4">
            <div
              role="alert"
              className="flex gap-2 rounded-md bg-status-warning-bg p-3 text-body-sm text-status-warning-fg"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <p>
                The setup password is shown <strong>only now</strong> and cannot be viewed again. It
                works once and expires {formatDateTime(credential.expiresAt)}. It is not the mailbox
                password.
              </p>
            </div>
            <Field label="MCP server URL" value={url} />
            <Field label="MCP username" value={credential.username} />
            <Field label="Setup password" value={credential.setupPassword} />
            <p className="text-body-sm text-text-secondary">
              In ChatGPT, add a connector with the MCP server URL and OAuth authentication, and
              leave its <strong>OAuth Client ID</strong> and <strong>Client Secret</strong> fields
              empty. The username and setup password are entered on the sign-in page that opens when
              connecting.
            </p>
            <div className="flex flex-col gap-1">
              <span className="text-caption font-medium text-text-muted">Permissions</span>
              <ul className="list-disc pl-5 text-body-sm text-text-primary">
                {permissions.map((scope) => (
                  <li key={scope}>{MCP_SCOPE_LABELS[scope]}</li>
                ))}
              </ul>
            </div>
            <div className="flex flex-wrap gap-2">
              <CopyButton
                variant="primary"
                label="Copy connection details"
                value={buildMcpConnectionDetailsText({
                  mcpUrl: url,
                  mailbox,
                  username: credential.username,
                  setupPassword: credential.setupPassword,
                  permissions,
                  expiresAt: credential.expiresAt,
                })}
              />
              <CopyButton
                label="Copy setup instructions"
                value={buildMcpSetupInstructionsText({ mcpUrl: url, mailbox })}
              />
            </div>
            <div className="flex items-start gap-2">
              <Checkbox
                id="mcp-credential-ack"
                checked={acknowledged}
                onCheckedChange={(checked) => setAcknowledged(checked === true)}
              />
              <Label htmlFor="mcp-credential-ack" className="text-body-sm font-normal">
                I have copied the setup password. I understand it cannot be shown again.
              </Label>
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="primary" disabled={!acknowledged} onClick={close}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
