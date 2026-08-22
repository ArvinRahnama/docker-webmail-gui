/**
 * `/api/v1/notifications/*` (M11 — ARCHITECTURE.md §7.3). A thin layer
 * over {@link NotificationsRepository}: map its internal rows (which
 * carry `dedupeKey`, never sent to a client — see that module's own doc
 * comment) to the public `Notification` shape via
 * {@link linkForDedupeKey}, and implement "dismiss" as marking read,
 * never as resolving (`notifications.ts`'s own header on why).
 */
import type { Notification, NotificationListResponse } from '@dwg/shared';
import { AppError } from '../../platform/errors.js';
import { linkForDedupeKey } from './notification-sources.js';
import type { NotificationRow, NotificationsRepository } from './notifications.repository.js';

function toPublic(row: NotificationRow): Notification {
  return {
    id: row.id,
    severity: row.severity,
    title: row.title,
    body: row.body,
    createdAt: row.createdAt,
    readAt: row.readAt,
    resolvedAt: row.resolvedAt,
    link: linkForDedupeKey(row.dedupeKey),
  };
}

export class NotificationsService {
  constructor(private readonly repository: NotificationsRepository) {}

  list(): NotificationListResponse {
    return {
      notifications: this.repository.list().map(toPublic),
      unreadCount: this.repository.countUnread(),
    };
  }

  /** "Dismiss" (UX_ARCHITECTURE.md §8) — marks read, never resolves. Throws if `id` does not exist, so a stale client can't silently no-op against a row that was never there. */
  markRead(id: string): void {
    if (this.repository.getById(id) === null) {
      throw new AppError('NOT_FOUND', `No notification with id ${id}.`);
    }
    this.repository.markRead(id, new Date().toISOString());
  }

  markAllRead(): void {
    this.repository.markAllRead(new Date().toISOString());
  }
}
