/**
 * The fixed, closed set of conditions this app ever turns into a
 * notification (M11 — ARCHITECTURE.md §7.3's `notifications` table),
 * every one of them a `DashboardSignal.id` or a synthesized verdict
 * problem id `dashboard.service.ts`'s `buildVerdict` can produce
 * (`dashboard.service.test.ts` and this module's own test both assert the
 * two stay in sync). Deliberately a flat, explicit map — mirroring
 * `platform/audit.ts`'s `AUDIT_ACTIONS` — rather than a function that
 * could invent a new dedupe key at runtime from admin-influenced input;
 * every key here is one this module's own author has explicitly seen.
 *
 * `link` mirrors `DashboardSignal.link`'s convention exactly: `null` means
 * this project genuinely has nowhere more specific to send an admin yet
 * (Rspamd — see `dashboard.ts`'s header on the missing `/security/rspamd`
 * page), never a placeholder or a guess.
 */
import type { NotificationSeverity } from '@dwg/shared';

export interface NotificationSource {
  /**
   * Fixed per condition, not derived fresh from the signal's exact
   * `healthy | warning | critical | unknown` state on every tick — a
   * notification's severity is "how urgently should an admin look at
   * this", a coarser three-way judgement than the six-state status
   * vocabulary's `unknown` (AGENT_BRIEF.md §4). `docker-daemon`, whose own
   * `HealthCheck` only ever reports `healthy` or `unknown` (never
   * `warning`/`critical` — `health.service.ts`'s `checkDockerDaemon`), is
   * still worth surfacing as a real, actionable `warning` here: "this
   * project could not verify the Docker daemon" is something to look at,
   * even though it is not a confirmed failure.
   */
  readonly severity: NotificationSeverity;
  readonly link: string | null;
}

export const NOTIFICATION_SOURCES: Readonly<Record<string, NotificationSource>> = {
  broker: { severity: 'critical', link: '/docker/health' },
  'managed-container': { severity: 'critical', link: '/docker/health' },
  'docker-daemon': { severity: 'warning', link: '/docker/health' },
  rspamd: { severity: 'critical', link: null },
  clamav: { severity: 'critical', link: '/security/clamav' },
  fail2ban: { severity: 'critical', link: '/security/fail2ban' },
  'tls-cert-expiring': { severity: 'warning', link: '/security/tls' },
  'no-recent-verified-backup': { severity: 'warning', link: '/maintenance/backups' },
  'update-available': { severity: 'info', link: '/maintenance/updates' },
} as const;

export const NOTIFICATION_DEDUPE_KEYS: readonly string[] = Object.keys(NOTIFICATION_SOURCES);

export function linkForDedupeKey(dedupeKey: string): string | null {
  return NOTIFICATION_SOURCES[dedupeKey]?.link ?? null;
}
