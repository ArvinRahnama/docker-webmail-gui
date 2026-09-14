/**
 * Topbar notification bell (M11 — UX_ARCHITECTURE.md §5.3, §8's Tier 1
 * "dismiss notification" example). Every row here is a real, persisted
 * `notifications` row the evaluator derived from an actual subsystem
 * signal (`notifications-evaluator.ts`) — there is no client-side
 * synthesis of a notification anywhere in this file.
 *
 * "Dismiss" marks read, never resolves — see `notifications.service.ts`'s
 * header for why an admin acknowledging a warning cannot make the
 * underlying condition go away.
 */
import { Link } from 'react-router-dom';
import { Bell } from 'lucide-react';
import type { Notification } from '@dwg/shared';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { StatusBadge } from '@/components/status/status-badge';
import type { Status } from '@/components/status/status';
import { formatDateTime } from '@/lib/format';
import {
  useMarkAllNotificationsReadMutation,
  useMarkNotificationReadMutation,
  useNotificationsQuery,
} from './use-notifications-queries';

const SEVERITY_TO_STATUS: Readonly<Record<Notification['severity'], Status>> = {
  info: 'info',
  warning: 'warning',
  critical: 'critical',
};

function NotificationRow({ notification }: { readonly notification: Notification }) {
  const markRead = useMarkNotificationReadMutation();
  const isUnread = notification.readAt === null;

  const body = (
    <div className="flex flex-col gap-1">
      {/* Wraps so a long title gets its own line instead of a squeezed
          column beside the badge; titles and bodies can carry unbroken
          FQDNs, paths and digests, hence overflow-wrap:anywhere. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusBadge status={SEVERITY_TO_STATUS[notification.severity]} />
        <span className="min-w-0 text-body-sm font-medium text-text-primary [overflow-wrap:anywhere]">
          {notification.title}
        </span>
      </div>
      {notification.body ? (
        <p className="text-caption text-text-secondary [overflow-wrap:anywhere]">
          {notification.body}
        </p>
      ) : null}
      <span className="text-caption text-text-muted">
        {formatDateTime(notification.createdAt)}
        {notification.resolvedAt !== null ? ' · Resolved' : ''}
      </span>
    </div>
  );

  return (
    <div
      className={`flex items-start justify-between gap-2 rounded-sm px-2 py-2 ${isUnread ? 'bg-bg-inset' : ''}`}
    >
      {notification.link !== null ? (
        <Link to={notification.link} className="min-w-0 flex-1">
          {body}
        </Link>
      ) : (
        <div className="min-w-0 flex-1">{body}</div>
      )}
      {isUnread ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          pending={markRead.isPending}
          onClick={() => markRead.mutate(notification.id)}
        >
          Dismiss
        </Button>
      ) : null}
    </div>
  );
}

export function NotificationBell() {
  const query = useNotificationsQuery();
  const markAllRead = useMarkAllNotificationsReadMutation();
  const unreadCount = query.data?.unreadCount ?? 0;
  const notifications = query.data?.notifications ?? [];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
          className="relative"
        >
          <Bell className="size-4" aria-hidden="true" />
          {unreadCount > 0 ? (
            <span
              className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-status-critical-fg text-[10px] font-semibold text-white"
              aria-hidden="true"
            >
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      {/* Column flex so the list below takes whatever height the (viewport-
          clamped) menu has left and scrolls, keeping the header in view. */}
      <DropdownMenuContent
        align="end"
        collisionPadding={8}
        className="flex w-80 max-w-[calc(100vw-1rem)] flex-col"
      >
        <div className="flex items-center justify-between px-2 py-1">
          <DropdownMenuLabel className="p-0">Notifications</DropdownMenuLabel>
          {unreadCount > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              pending={markAllRead.isPending}
              onClick={() => markAllRead.mutate()}
            >
              Mark all read
            </Button>
          ) : null}
        </div>
        <DropdownMenuSeparator className="shrink-0" />
        {notifications.length === 0 ? (
          <p className="px-2 py-3 text-body-sm text-text-secondary">Nothing to report.</p>
        ) : (
          <div className="flex max-h-96 min-h-0 flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden">
            {notifications.map((notification) => (
              <NotificationRow key={notification.id} notification={notification} />
            ))}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
