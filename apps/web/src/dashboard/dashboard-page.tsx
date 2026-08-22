/**
 * `/` — the dashboard (M11 — IMPLEMENTATION_PLAN.md §3's exit criterion:
 * "Dashboard renders with a subsystem down"; UX_ARCHITECTURE.md §6.1).
 * Four rows, exactly as specified: a one-sentence verdict, four metric
 * tiles, a two-column service-health/security-expiry split, and recent
 * activity.
 *
 * **What this deliberately does not show**, because nothing in this
 * codebase can back it honestly (`@dwg/shared`'s `dashboard.ts` has the
 * full reasoning for each):
 *
 *  - No "mail flow (24h) sent/received" tile — no real source exists.
 *  - No per-domain DKIM/SPF/DMARC rollup — `email-auth-list-page.tsx`
 *    already declined N live DNS checks on every load for the same
 *    domain list this page would otherwise repeat that call against.
 *  - "Docker storage" (images + build cache), not "disk used/total" — no
 *    host-filesystem capability exists in this codebase, only Docker's
 *    own storage accounting (`GET /system/df`).
 *  - No Postfix/Dovecot rows in the service health list — neither exposes
 *    an independent liveness signal in this stack.
 *
 * Every tile renders its own `unknown` state honestly
 * (`MetricTile`'s `unknown` prop, already built for exactly this) rather
 * than a blank space or a silently-stale number — this is what the
 * degraded-state exit criterion is actually checking.
 */
import { Link } from 'react-router-dom';
import type { DashboardActivityEntry, DashboardSignal } from '@dwg/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState } from '@/components/error-state';
import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/status/status-badge';
import { HealthIndicator } from '@/components/status/health-indicator';
import type { Status } from '@/components/status/status';
import { MetricTile } from '@/components/metric-tile';
import { ApiClientError, ApiError } from '@/lib/api-client';
import { formatBytes, formatCount, formatDateTime } from '@/lib/format';
import { useDashboardQuery } from './use-dashboard-queries';

function errorIdOf(error: unknown): string {
  return error instanceof ApiError || error instanceof ApiClientError ? error.errorId : 'unknown';
}

/** `HealthCheckState`/`DashboardTileState` values are already the `Status` vocabulary's own names except `'ok'` (dashboard.ts's own two-state tile enum) — normalise that one case rather than declaring a second status type. */
function toStatus(state: string): Status {
  return state === 'ok' ? 'healthy' : (state as Status);
}

function SignalRow({ signal }: { readonly signal: DashboardSignal }) {
  const content = (
    <div className="flex items-center justify-between gap-3 rounded-sm px-2 py-1.5">
      <div className="flex items-center gap-2">
        <StatusBadge status={toStatus(signal.state)} />
        <span className="text-body-sm font-medium text-text-primary">{signal.label}</span>
      </div>
      {signal.message ? (
        <span className="text-body-sm text-text-secondary">{signal.message}</span>
      ) : null}
    </div>
  );
  if (signal.link === null) return content;
  return (
    <Link to={signal.link} className="block rounded-sm hover:bg-bg-inset">
      {content}
    </Link>
  );
}

const ACTION_LABELS: Readonly<Record<string, string>> = {
  'auth.login.success': 'Signed in',
  'auth.login.failure': 'Failed sign-in',
  'auth.logout': 'Signed out',
  'auth.password_change': 'Changed password',
  'admin.bootstrap_created': 'Bootstrap administrator created',
  'admin.create': 'Administrator created',
  'admin.update': 'Administrator updated',
  'admin.delete': 'Administrator deleted',
  'mailbox.create': 'Mailbox created',
  'mailbox.password_change': 'Mailbox password changed',
  'mailbox.restrict': 'Mailbox restricted',
  'mailbox.quota_set': 'Mailbox quota set',
  'mailbox.quota_clear': 'Mailbox quota cleared',
  'mailbox.delete': 'Mailbox deleted',
  'mailbox.bulk_restrict': 'Bulk mailbox restriction',
  'mailbox.bulk_quota': 'Bulk quota change',
  'alias.create': 'Alias created',
  'alias.update': 'Alias updated',
  'alias.delete': 'Alias deleted',
  'dkim.generate': 'DKIM key generated',
  'rspamd.threshold_set': 'Rspamd threshold changed',
  'rspamd.symbol_score_set': 'Rspamd symbol score changed',
  'rspamd.learn_spam': 'Rspamd learned spam',
  'rspamd.learn_ham': 'Rspamd learned ham',
  'clamav.signature_update': 'ClamAV signatures updated',
  'fail2ban.ban': 'IP banned',
  'fail2ban.unban': 'IP unbanned',
  'sieve.script_update': 'Sieve script updated',
  'sieve.script_activate': 'Sieve script activated',
  'sieve.script_deactivate': 'Sieve script deactivated',
  'autoresponder.update': 'Autoresponder updated',
  'container.start': 'Container started',
  'container.stop': 'Container stopped',
  'container.restart': 'Container restarted',
  'volume.remove': 'Volume removed',
  'image.prune': 'Images pruned',
  'console.exec': 'Console command run',
  'job.cancel': 'Job cancelled',
  'backup.create': 'Backup created',
  'backup.verify': 'Backup verified',
  'backup.delete': 'Backup deleted',
  'backup.download': 'Backup downloaded',
  'backup.restore': 'Backup restored',
  'config.apply': 'Configuration applied',
  'config.reveal_secret': 'Secret revealed',
  'update.apply_refused': 'Update apply refused',
};

/** Falls back to the raw action string (space-separated) rather than hiding an action this table has not been told the label for yet — a new `AuditAction` should never make an activity row disappear. */
function labelForAction(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/[._]/g, ' ');
}

function ActivityRow({ entry }: { readonly entry: DashboardActivityEntry }) {
  return (
    <li className="flex items-center justify-between gap-3 border-b border-border-subtle px-1 py-2 text-body-sm last:border-b-0">
      <div className="flex flex-col">
        <span className="font-medium text-text-primary">{labelForAction(entry.action)}</span>
        <span className="text-caption text-text-muted">
          {entry.actorLabel}
          {entry.target ? ` · ${entry.target}` : ''}
        </span>
      </div>
      <div className="flex items-center gap-2">
        {entry.result === 'failure' ? <StatusBadge status="critical" label="Failed" /> : null}
        <span className="text-caption text-text-muted">{formatDateTime(entry.occurredAt)}</span>
      </div>
    </li>
  );
}

export function DashboardPage() {
  const query = useDashboardQuery();

  if (query.isError) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Dashboard" description="Is it healthy. Is anything broken." />
        <ErrorState
          message="Could not load the dashboard."
          errorId={errorIdOf(query.error)}
          onRetry={() => void query.refetch()}
        />
      </div>
    );
  }

  const data = query.data;
  if (data === undefined) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Dashboard" description="Is it healthy. Is anything broken." />
        <Skeleton className="h-24 w-full" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const { verdict, metrics, serviceHealth, securityExpiry, recentActivity } = data;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Dashboard" description="Is it healthy. Is anything broken." />

      {/* Row 1 — verdict. */}
      <Card>
        <CardContent className="flex flex-col gap-3 p-5">
          <div className="flex items-center gap-3">
            <StatusBadge status={toStatus(verdict.tone)} variant="solid" />
            <span className="text-display font-semibold text-text-primary">{verdict.headline}</span>
          </div>
          {verdict.problems.length > 0 ? (
            <ul className="flex flex-col gap-1 border-t border-border-subtle pt-3">
              {verdict.problems.map((problem) => (
                <li key={problem.id}>
                  <SignalRow signal={problem} />
                </li>
              ))}
            </ul>
          ) : null}
        </CardContent>
      </Card>

      {/* Row 2 — four metric tiles. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile
          label="Mail queue"
          value={metrics.queue.total ?? 0}
          unknown={metrics.queue.state === 'unknown'}
          {...(metrics.queue.deferred !== null && metrics.queue.deferred > 0
            ? { unit: `(${metrics.queue.deferred} deferred)` }
            : {})}
        />
        <MetricTile
          label="Spam blocked (24h)"
          value={metrics.spamBlocked.collecting ? 'Collecting' : (metrics.spamBlocked.count ?? 0)}
          unknown={false}
        />
        <MetricTile
          label="Docker storage"
          value={
            metrics.storage.df
              ? formatBytes(metrics.storage.df.layersSizeBytes + metrics.storage.df.buildCacheBytes)
              : ''
          }
          unknown={metrics.storage.state === 'unknown'}
        />
        <MetricTile
          label="Mailboxes / domains"
          value={
            metrics.mail.state === 'ok'
              ? `${formatCount(metrics.mail.mailboxCount)} / ${formatCount(metrics.mail.domainCount)}`
              : ''
          }
          unknown={metrics.mail.state === 'unknown'}
        />
      </div>

      {/* Row 3 — service health (left) and security & expiry (right). */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Service health</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1">
            {serviceHealth.length === 0 ? (
              <p className="text-body-sm text-text-secondary">Nothing to check yet.</p>
            ) : (
              serviceHealth.map((signal) => <SignalRow key={signal.id} signal={signal} />)
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Security & expiry</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-body-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-text-secondary">TLS certificates</span>
              <div className="flex items-center gap-2">
                <HealthIndicator status={toStatus(securityExpiry.tlsState)} showLabel={false} />
                <span>
                  {securityExpiry.tlsExpiryDays === null
                    ? 'Unknown'
                    : securityExpiry.tlsExpiryDays < 0
                      ? 'Expired'
                      : `${securityExpiry.tlsExpiryDays} day(s) left`}
                </span>
              </div>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-text-secondary">Last backup</span>
              <span>{formatDateTime(securityExpiry.lastBackupAt)}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-text-secondary">Backup verified</span>
              <span>
                {securityExpiry.lastBackupVerified === null
                  ? 'No backup yet'
                  : securityExpiry.lastBackupVerified
                    ? 'Yes'
                    : 'No'}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-text-secondary">Update available</span>
              <span>
                {securityExpiry.updateAvailable === null
                  ? 'Could not check'
                  : securityExpiry.updateAvailable
                    ? 'Yes'
                    : 'Up to date'}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Row 4 — recent activity. Audit log only; see this file's header and dashboard.ts on why there is no Docker-events half of this feed. */}
      <Card>
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
        </CardHeader>
        <CardContent>
          {recentActivity.length === 0 ? (
            <p className="text-body-sm text-text-secondary">No activity recorded yet.</p>
          ) : (
            <ul>
              {recentActivity.map((entry) => (
                <ActivityRow key={entry.id} entry={entry} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
