/** MCP audit events rendered as a compact, text-only list (event names, mailbox, tool, outcome — never content). */
import type { McpAuditEvent } from '@dwg/shared';
import { formatDateTime } from '@/lib/format';

export function EventList({ events, empty }: { events: readonly McpAuditEvent[]; empty: string }) {
  if (events.length === 0) return <p className="text-body-sm text-text-muted">{empty}</p>;
  return (
    <ul className="flex flex-col divide-y divide-border-subtle">
      {events.map((event) => (
        <li
          key={event.id}
          className="flex flex-col gap-0.5 py-2 text-body-sm sm:flex-row sm:items-baseline sm:gap-3"
        >
          <span className="shrink-0 text-caption text-text-muted">
            {formatDateTime(event.occurredAt)}
          </span>
          <span className="min-w-0 flex-1 break-words">
            <span
              className={
                event.result === 'failure'
                  ? 'font-medium text-status-critical-fg'
                  : 'font-medium text-text-primary'
              }
            >
              {event.event}
            </span>
            {event.mailbox ? <span className="text-text-secondary"> · {event.mailbox}</span> : null}
            {typeof event.details['tool'] === 'string' ? (
              <span className="text-text-secondary"> · {event.details['tool']}</span>
            ) : null}
            {typeof event.details['reason'] === 'string' ? (
              <span className="text-text-muted"> · {event.details['reason']}</span>
            ) : null}
          </span>
          <span className="shrink-0 truncate text-caption text-text-muted">{event.actor}</span>
        </li>
      ))}
    </ul>
  );
}
