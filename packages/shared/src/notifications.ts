/**
 * `GET /api/v1/notifications`, `POST /api/v1/notifications/:id/read`,
 * `POST /api/v1/notifications/read-all` (M11 — ARCHITECTURE.md §7.3's
 * `notifications` table, "Deduplicated alerts"; UX_ARCHITECTURE.md §5.3's
 * topbar bell; §8's Tier 1 "dismiss notification" example).
 *
 * Every notification is derived from a real, already-computed signal — the
 * same facts `GET /api/v1/dashboard` reports (`modules/notifications/
 * notifications-evaluator.ts` and `modules/dashboard/dashboard.service.ts`
 * are deliberately built on the same underlying service calls, not two
 * independent readings of "is TLS okay" that could disagree). There is no
 * free-form "create a notification" endpoint anywhere in this schema —
 * matching the audit log's own "no admin-authored free text becomes a
 * system record" discipline (`platform/audit.ts`) — because a notification
 * is a claim about real system state, never an admin's own words.
 *
 * "Dismiss" (§8) is implemented as marking a notification **read**, never
 * as resolving it: an admin acknowledging a warning does not make a
 * certificate stop expiring. Only the evaluator, re-observing the real
 * condition, ever sets a notification resolved.
 */
import { z } from 'zod';

export const NOTIFICATION_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];
export const NotificationSeveritySchema = z.enum(NOTIFICATION_SEVERITIES);

export const NotificationSchema = z.object({
  id: z.string(),
  severity: NotificationSeveritySchema,
  title: z.string(),
  body: z.string().nullable(),
  createdAt: z.string(),
  readAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  /** App-relative path to the page that explains or fixes this, or `null` — same convention as `DashboardSignal.link` (`dashboard.ts`), for a source that genuinely has nowhere to point to (`apps/server/src/modules/notifications/notification-sources.ts` is the closed map deciding this). */
  link: z.string().nullable(),
});
export type Notification = z.infer<typeof NotificationSchema>;

export const NotificationListResponseSchema = z.object({
  notifications: z.array(NotificationSchema),
  /** Count of currently-active (`resolvedAt` null) and unread (`readAt` null) notifications — what the topbar bell badge shows. Computed server-side so the client never has to re-derive "what counts as unread" itself. */
  unreadCount: z.number().nonnegative(),
});
export type NotificationListResponse = z.infer<typeof NotificationListResponseSchema>;
