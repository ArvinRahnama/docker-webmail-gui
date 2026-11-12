import { Inbox, ShieldBan, ShieldCheck } from 'lucide-react';
import type { SenderReport } from '@dwg/shared';
import { BreakableText } from '@/components/breakable-text';
import { DataTable, type DataTableColumn } from '@/components/data-table';
import { EmptyState } from '@/components/empty-state';
import { Badge } from '@/components/ui/badge';
import { formatDateTime } from '@/lib/format';

/** Users' Junk moves and what each did to the sender lists. Shared by the all-mailboxes and per-mailbox pages. */
export function SenderReportsTable({
  reports,
  isLoading,
  showMailbox,
}: {
  readonly reports: readonly SenderReport[];
  readonly isLoading: boolean;
  readonly showMailbox: boolean;
}) {
  const columns: DataTableColumn<SenderReport>[] = [
    {
      id: 'reportedAt',
      header: 'When',
      cell: (r) => <span className="whitespace-nowrap">{formatDateTime(r.reportedAt)}</span>,
      sortValue: (r) => r.reportedAt,
    },
    ...(showMailbox
      ? [
          {
            id: 'mailbox',
            header: 'Mailbox',
            cell: (r: SenderReport) => <BreakableText text={r.mailbox} />,
            sortValue: (r: SenderReport) => r.mailbox,
          },
        ]
      : []),
    {
      id: 'action',
      header: 'User said',
      cell: (r) =>
        r.action === 'ham' ? (
          <Badge variant="outline">
            <ShieldCheck className="size-3" aria-hidden="true" />
            Not spam
          </Badge>
        ) : (
          <Badge variant="outline">
            <ShieldBan className="size-3" aria-hidden="true" />
            Spam
          </Badge>
        ),
    },
    {
      id: 'sender',
      header: 'Sender',
      cell: (r) => (
        <span className="flex flex-col">
          <span className="break-words">{r.sender ?? '—'}</span>
          {r.clientIp ? (
            <span className="font-mono-sm text-caption text-text-muted">{r.clientIp}</span>
          ) : null}
        </span>
      ),
    },
    {
      id: 'outcome',
      header: 'Result',
      cell: (r) => <span className="break-words text-text-secondary">{r.outcome}</span>,
    },
  ];

  return (
    <DataTable
      data={reports}
      columns={columns}
      getRowId={(r) => `${r.reportedAt}|${r.mailbox}|${r.action}|${r.sender ?? ''}`}
      caption="Spam and not-spam reports from mailbox users"
      isLoading={isLoading}
      initialSort={{ id: 'reportedAt', desc: true }}
      emptyState={
        <EmptyState
          variant="first-run"
          icon={Inbox}
          title="No reports yet"
          description="When a user moves a message out of Junk, or into it, it appears here within a minute."
        />
      }
    />
  );
}
