import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import type { DnsIssue, DnsRecordState } from '@dwg/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/status/status-badge';
import type { Status } from '@/components/status/status';
import { cn } from '@/lib/cn';

/**
 * Maps the server's five-state DNS vocabulary onto the six-state UI
 * `Status` vocabulary (`components/status/status.ts`). `unknown` maps
 * 1:1 onto the UI's own `unknown` — grey, never yellow
 * (FEATURE_MATRIX.md §10; UX_ARCHITECTURE.md §3.3's "single most
 * important colour decision in the product"). `detected` maps to `info`:
 * something is there, but this checker did not assert full validity.
 */
const DNS_STATE_TO_STATUS: Readonly<Record<DnsRecordState, Status>> = {
  valid: 'healthy',
  detected: 'info',
  invalid: 'critical',
  missing: 'warning',
  unknown: 'unknown',
};

const ISSUE_DOT_CLASS: Readonly<Record<DnsIssue['severity'], string>> = {
  error: 'bg-status-critical-fg',
  warning: 'bg-status-warning-fg',
  info: 'bg-status-info-fg',
};

export interface DnsRecordCardProps {
  readonly title: string;
  readonly state: DnsRecordState;
  /** The raw record value(s) found, for display and copy. `[]` when nothing was found. */
  readonly values: readonly string[];
  /** One-line explanation of what this record is for — shown even when everything is fine. */
  readonly description: string;
  readonly issues?: readonly DnsIssue[];
}

/**
 * `DnsRecordCard` (UX_ARCHITECTURE.md §7): one DNS record's state, icon +
 * text status chip, the current value with copy, and its explanation.
 */
export function DnsRecordCard({
  title,
  state,
  values,
  description,
  issues = [],
}: DnsRecordCardProps) {
  const status = DNS_STATE_TO_STATUS[state];

  async function copyValue(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success('Copied to clipboard.');
    } catch {
      toast.error('Could not copy — your browser blocked clipboard access.');
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-body font-semibold">{title}</CardTitle>
        <StatusBadge status={status} />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-body-sm text-text-secondary">{description}</p>

        {values.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {values.map((value, index) => (
              <li
                key={`${index}-${value.slice(0, 16)}`}
                className="flex items-start justify-between gap-2 rounded-sm border border-border-subtle bg-bg-inset px-2.5 py-2"
              >
                <code className="min-w-0 flex-1 break-all font-mono-sm text-caption text-text-primary">
                  {value}
                </code>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-auto shrink-0 p-1"
                  onClick={() => void copyValue(value)}
                  aria-label={`Copy ${title} value`}
                >
                  <Copy className="size-3.5" aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-body-sm text-text-muted">No record found.</p>
        )}

        {issues.length > 0 ? (
          <ul className="flex flex-col gap-1.5 border-t border-border-subtle pt-2.5">
            {issues.map((issue, index) => (
              <li key={index} className="flex items-start gap-2 text-caption text-text-secondary">
                <span
                  className={cn(
                    'mt-1 size-1.5 shrink-0 rounded-full',
                    ISSUE_DOT_CLASS[issue.severity],
                  )}
                  aria-hidden="true"
                />
                <span>{issue.message}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}
