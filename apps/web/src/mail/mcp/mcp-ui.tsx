/**
 * Small, shared presentation helpers for the MCP pages: the mapping from
 * connection status / credential health onto the app's six-state status
 * vocabulary (UX_ARCHITECTURE.md §3.3), and a copy-to-clipboard button.
 */
import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import type { McpConnectionStatus, McpCredentialHealth, McpEnrollmentSummary } from '@dwg/shared';
import { Button } from '@/components/ui/button';
import type { Status } from '@/components/status/status';
import { formatDateTime } from '@/lib/format';

export const CONNECTION_STATUS_DISPLAY: Readonly<
  Record<McpConnectionStatus, { status: Status; label: string }>
> = {
  active: { status: 'healthy', label: 'Active' },
  pending: { status: 'info', label: 'Awaiting authorization' },
  disabled: { status: 'unknown', label: 'Disabled' },
  suspended: { status: 'warning', label: 'Suspended' },
  expired: { status: 'unknown', label: 'Expired' },
  revoked: { status: 'critical', label: 'Revoked' },
};

export const CREDENTIAL_HEALTH_DISPLAY: Readonly<
  Record<McpCredentialHealth, { status: Status; label: string }>
> = {
  healthy: { status: 'healthy', label: 'Verified' },
  missing: { status: 'warning', label: 'Not provisioned' },
  stale: { status: 'warning', label: 'Stale — password changed' },
  invalid: { status: 'critical', label: 'Rejected by mail server' },
  mailbox_missing: { status: 'warning', label: 'Mailbox not found' },
  revoked: { status: 'critical', label: 'Mailbox deleted' },
  vault_unavailable: { status: 'critical', label: 'Vault key unavailable' },
};

export function enrollmentLabel(enrollment: McpEnrollmentSummary): string {
  switch (enrollment.state) {
    case 'active':
      return `Setup password unused — expires ${formatDateTime(enrollment.expiresAt)}`;
    case 'consumed':
      return `Setup password used ${formatDateTime(enrollment.consumedAt)}`;
    case 'expired':
      return 'Setup password expired unused';
    case 'locked':
      return 'Setup password locked after failed attempts';
    case 'revoked':
      return 'Setup password revoked';
    case 'none':
      return 'No setup password issued';
  }
}

/** Like `formatDateTime`, but a `null` means "has not happened", not "unknown". */
export function formatEventDate(iso: string | null, never = 'Never'): string {
  return iso === null ? never : formatDateTime(iso);
}

export function CopyButton({
  value,
  label,
  size = 'sm',
  variant = 'secondary',
}: {
  readonly value: string;
  readonly label: string;
  readonly size?: 'sm' | 'default';
  readonly variant?: 'secondary' | 'ghost' | 'primary';
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size={size}
      variant={variant}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          toast.success('Copied to clipboard.');
          setTimeout(() => setCopied(false), 2000);
        } catch {
          toast.error(
            'Could not copy — your browser blocked clipboard access. Select the text and copy it manually.',
          );
        }
      }}
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {label}
    </Button>
  );
}
