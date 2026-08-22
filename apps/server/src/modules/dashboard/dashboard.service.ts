/**
 * `GET /api/v1/dashboard` (M11 — IMPLEMENTATION_PLAN.md §3's exit
 * criterion: "Dashboard renders with a subsystem down"; UX_ARCHITECTURE.md
 * §6.1; FEATURE_MATRIX.md §1). Composes ten already-real subsystems —
 * every one of them an existing service or driver call this codebase
 * already ships and tests elsewhere — into one response.
 *
 * **Per-tile isolation is the entire point of this file.** Every
 * subsystem read below runs inside its own `try`/`catch`; one collector
 * throwing degrades *that* tile to `unknown` and never touches any other
 * tile or aborts the response (FEATURE_MATRIX.md §1: "per-tile failures
 * isolated so one dead subsystem cannot blank the page" —
 * `dashboard.service.test.ts`'s "a subsystem down" tests are what M11's
 * own exit criterion is checking). `Promise.allSettled` is deliberately
 * not used for the whole set — each collector already owns its own
 * try/catch and returns a real value either way, which reads the same but
 * keeps every collector's fallback value colocated with the call that can
 * fail, rather than a second mapping step translating settlement results
 * back into tile shapes.
 *
 * {@link getSnapshot} is also the **single source of truth**
 * `modules/notifications/notifications-evaluator.ts` builds on — that
 * module turns `verdict.problems` into persisted, dismissible
 * notifications on a timer, rather than re-deriving "is TLS okay" a
 * second, potentially disagreeing way.
 */
import type {
  DashboardActivityEntry,
  DashboardMetrics,
  DashboardResponse,
  DashboardSecurityExpiry,
  DashboardSignal,
  DashboardTileState,
  HealthCheckState,
} from '@dwg/shared';
import type { DmsDriver } from '../../drivers/dms/index.js';
import { countByQueueName } from '../../drivers/dms/parsers/postqueue.js';
import type { Database } from '../../platform/db.js';
import { listRecentAuditEvents } from '../../platform/audit.js';
import type { HealthService } from '../docker/health.service.js';
import type { MonitoringService } from '../docker/monitoring.service.js';
import type { TlsService } from '../security/tls.service.js';
import type { RspamdService } from '../security/rspamd.service.js';
import type { ClamavService } from '../security/clamav.service.js';
import type { Fail2banService } from '../security/fail2ban.service.js';
import { getSpamBlocked24h } from '../security/rspamd-sampler.js';
import type { BackupsRepository } from '../backups/backups.repository.js';
import type { UpdatesService } from '../updates/updates.service.js';

const RECENT_ACTIVITY_LIMIT = 10;

const HEALTH_STATE_RANK: Readonly<Record<HealthCheckState, number>> = {
  critical: 3,
  warning: 2,
  unknown: 1,
  healthy: 0,
};

/** Worst-of, per the health engine's own independence rule (ARCHITECTURE.md §7.7) — used everywhere this file rolls several signals up into one. `critical` beats `warning` beats `unknown` beats `healthy`, matching every other worst-of in this codebase (e.g. `computeCertificateHealth`'s callers). */
export function worstHealthState(states: readonly HealthCheckState[]): HealthCheckState {
  let worst: HealthCheckState = 'healthy';
  for (const state of states) {
    if (HEALTH_STATE_RANK[state] > HEALTH_STATE_RANK[worst]) worst = state;
  }
  return worst;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class DashboardService {
  constructor(
    private readonly dmsDriver: DmsDriver,
    private readonly healthService: HealthService,
    private readonly monitoringService: MonitoringService,
    private readonly tlsService: TlsService,
    private readonly rspamdService: RspamdService,
    private readonly clamavService: ClamavService,
    private readonly fail2banService: Fail2banService,
    private readonly backupsRepository: BackupsRepository,
    private readonly updatesService: UpdatesService,
    private readonly db: Database,
  ) {}

  async getSnapshot(): Promise<DashboardResponse> {
    const [serviceHealth, metrics, securityExpiry, recentActivity] = await Promise.all([
      this.collectServiceHealth(),
      this.collectMetrics(),
      this.collectSecurityExpiry(),
      this.collectRecentActivity(),
    ]);

    const verdict = buildVerdict(serviceHealth, securityExpiry);

    return {
      generatedAt: nowIso(),
      verdict,
      metrics,
      serviceHealth,
      securityExpiry,
      recentActivity,
    };
  }

  // -------------------------------------------------------------------
  // Row 3, left — service health. Container/broker/docker-daemon are
  // always present (no capability concept); Rspamd/ClamAV/Fail2ban are
  // omitted entirely when their capability is genuinely disabled — see
  // dashboard.ts's own header on why there are no fabricated
  // Postfix/Dovecot rows either.
  // -------------------------------------------------------------------

  private async collectServiceHealth(): Promise<DashboardSignal[]> {
    const [coreChecks, rspamd, clamav, fail2ban] = await Promise.all([
      this.healthService.getChecks(),
      this.collectRspamdSignal(),
      this.collectClamavSignal(),
      this.collectFail2banSignal(),
    ]);

    // All three come from HealthService, which already has its own
    // dedicated page (`/docker/health`) rendering exactly these checks —
    // the most accurate link available, more so than the containers list.
    const coreSignals: DashboardSignal[] = coreChecks.map((check) => ({
      id: check.id,
      label: check.label,
      state: check.state,
      message: check.message,
      link: '/docker/health',
      checkedAt: check.checkedAt,
    }));

    return [
      ...coreSignals,
      ...(rspamd ? [rspamd] : []),
      ...(clamav ? [clamav] : []),
      ...(fail2ban ? [fail2ban] : []),
    ];
  }

  /** `null` when Rspamd is not enabled on this deployment — omitted, not forced into one of the four states (AGENT_BRIEF.md §1). `link: null` — no `/security/rspamd` page exists yet in this app; see `dashboard.ts`'s header. */
  private async collectRspamdSignal(): Promise<DashboardSignal | null> {
    try {
      const status = await this.rspamdService.getStatus();
      if (!status.capability.supported) return null;
      return {
        id: 'rspamd',
        label: 'Rspamd',
        state: status.reachable ? 'healthy' : 'critical',
        message: status.reachable ? null : (status.error ?? 'Rspamd is unreachable.'),
        link: null,
        checkedAt: nowIso(),
      };
    } catch (err) {
      return {
        id: 'rspamd',
        label: 'Rspamd',
        state: 'unknown',
        message: messageOf(err),
        link: null,
        checkedAt: nowIso(),
      };
    }
  }

  private async collectClamavSignal(): Promise<DashboardSignal | null> {
    try {
      const status = await this.clamavService.getStatus();
      if (!status.capability.supported) return null;
      return {
        id: 'clamav',
        label: 'ClamAV',
        state: status.reachable ? 'healthy' : 'critical',
        message: status.reachable ? null : (status.error ?? 'ClamAV is unreachable.'),
        link: '/security/clamav',
        checkedAt: nowIso(),
      };
    } catch (err) {
      return {
        id: 'clamav',
        label: 'ClamAV',
        state: 'unknown',
        message: messageOf(err),
        link: '/security/clamav',
        checkedAt: nowIso(),
      };
    }
  }

  /** `Fail2banService.getStatus()` has no soft `reachable` field — a `setup fail2ban` failure surfaces as a thrown `DmsCommandExecutionError`, caught here same as everywhere else in this file. */
  private async collectFail2banSignal(): Promise<DashboardSignal | null> {
    try {
      const capabilities = await this.dmsDriver.getCapabilities();
      if (!capabilities.fail2ban.supported) return null;
      await this.fail2banService.getStatus();
      return {
        id: 'fail2ban',
        label: 'Fail2ban',
        state: 'healthy',
        message: null,
        link: '/security/fail2ban',
        checkedAt: nowIso(),
      };
    } catch (err) {
      return {
        id: 'fail2ban',
        label: 'Fail2ban',
        state: 'critical',
        message: messageOf(err),
        link: '/security/fail2ban',
        checkedAt: nowIso(),
      };
    }
  }

  // -------------------------------------------------------------------
  // Row 2 — four metric tiles.
  // -------------------------------------------------------------------

  private async collectMetrics(): Promise<DashboardMetrics> {
    const [queue, spamBlocked, storage, mail] = await Promise.all([
      this.collectQueueTile(),
      this.collectSpamBlockedTile(),
      this.collectStorageTile(),
      this.collectMailCountsTile(),
    ]);
    return { queue, spamBlocked, storage, mail };
  }

  private async collectQueueTile(): Promise<DashboardMetrics['queue']> {
    try {
      const result = await this.dmsDriver.getMailQueue();
      const byQueue = countByQueueName(result.entries);
      return {
        state: 'ok' as DashboardTileState,
        message: null,
        total: result.entries.length,
        deferred: byQueue.deferred,
        byQueue,
      };
    } catch (err) {
      return {
        state: 'unknown' as DashboardTileState,
        message: messageOf(err),
        total: null,
        deferred: null,
        byQueue: null,
      };
    }
  }

  private async collectSpamBlockedTile(): Promise<DashboardMetrics['spamBlocked']> {
    // Never throws — pure SQLite reads over an already-migrated table.
    return getSpamBlocked24h(this.db);
  }

  private async collectStorageTile(): Promise<DashboardMetrics['storage']> {
    try {
      const snapshot = await this.monitoringService.getSnapshot();
      return { state: 'ok' as DashboardTileState, message: null, df: snapshot.df };
    } catch (err) {
      return { state: 'unknown' as DashboardTileState, message: messageOf(err), df: null };
    }
  }

  private async collectMailCountsTile(): Promise<DashboardMetrics['mail']> {
    try {
      const [accounts, aliases, domains] = await Promise.all([
        this.dmsDriver.listMailboxes(),
        this.dmsDriver.listAliases(),
        this.dmsDriver.listDomains(),
      ]);
      return {
        state: 'ok' as DashboardTileState,
        message: null,
        mailboxCount: accounts.entries.length,
        aliasCount: aliases.entries.length,
        domainCount: domains.length,
      };
    } catch (err) {
      return {
        state: 'unknown' as DashboardTileState,
        message: messageOf(err),
        mailboxCount: null,
        aliasCount: null,
        domainCount: null,
      };
    }
  }

  // -------------------------------------------------------------------
  // Row 3, right — security & expiry.
  // -------------------------------------------------------------------

  private async collectSecurityExpiry(): Promise<DashboardSecurityExpiry> {
    const [tls, backup, update] = await Promise.all([
      this.collectTlsExpiry(),
      this.collectBackupExpiry(),
      this.collectUpdateAvailability(),
    ]);
    return { ...tls, ...backup, updateAvailable: update };
  }

  private async collectTlsExpiry(): Promise<
    Pick<DashboardSecurityExpiry, 'tlsState' | 'tlsExpiryDays'>
  > {
    try {
      const status = await this.tlsService.getStatus();
      const withCertificates = status.endpoints.filter((endpoint) => endpoint.certificate !== null);
      const tlsState = worstHealthState(status.endpoints.map((endpoint) => endpoint.health));
      const tlsExpiryDays =
        withCertificates.length === 0
          ? null
          : Math.min(...withCertificates.map((endpoint) => endpoint.certificate!.daysRemaining));
      return { tlsState, tlsExpiryDays };
    } catch {
      return { tlsState: 'unknown', tlsExpiryDays: null };
    }
  }

  private async collectBackupExpiry(): Promise<
    Pick<DashboardSecurityExpiry, 'lastBackupAt' | 'lastBackupVerified'>
  > {
    // Pure SQLite reads — same "never throws" reasoning as collectSpamBlockedTile.
    const mostRecent = this.backupsRepository.list(1)[0] ?? null;
    const mostRecentVerified = this.backupsRepository.mostRecentVerified();
    return {
      lastBackupAt: mostRecent?.createdAt ?? null,
      lastBackupVerified: mostRecent === null ? null : mostRecentVerified !== null,
    };
  }

  private async collectUpdateAvailability(): Promise<boolean | null> {
    try {
      const status = await this.updatesService.getStatus();
      // `updates-page.tsx`'s own discipline, reused rather than re-decided:
      // `available === null` means "could not check", not "no update".
      return status.available === null ? null : status.updateAvailable;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------
  // Row 4 — recent activity. Audit log only; see dashboard.ts's header on
  // why there is no Docker-events half of this feed.
  // -------------------------------------------------------------------

  private async collectRecentActivity(): Promise<DashboardActivityEntry[]> {
    const rows = listRecentAuditEvents(this.db, RECENT_ACTIVITY_LIMIT);
    return rows.map((row) => ({
      id: row.id,
      occurredAt: row.occurredAt,
      actorLabel: row.actorLabel,
      action: row.action,
      target: row.target,
      result: row.result,
    }));
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Row 1 — the verdict. `problems` is the union of every non-healthy
 * `serviceHealth` entry plus synthesized signals for the security/expiry
 * facts that Row 3 right renders with richer framing than a plain chip
 * (TLS expiry, no-recent-verified-backup) — see `dashboard.service.test.ts`
 * for the exact thresholds each one uses. `NOTIFICATION_DEDUPE_KEYS` in
 * `modules/notifications/notification-sources.ts` enumerates every `id`
 * this function can ever produce; keep the two in sync (a test asserts
 * it, in that module's own test file).
 */
function buildVerdict(
  serviceHealth: readonly DashboardSignal[],
  securityExpiry: DashboardSecurityExpiry,
): DashboardResponse['verdict'] {
  const checkedAt = nowIso();
  const problems: DashboardSignal[] = serviceHealth.filter((signal) => signal.state !== 'healthy');

  if (securityExpiry.tlsState !== 'healthy') {
    problems.push({
      id: 'tls-cert-expiring',
      label: 'TLS certificate',
      state: securityExpiry.tlsState,
      message:
        securityExpiry.tlsExpiryDays === null
          ? 'Could not determine certificate expiry.'
          : securityExpiry.tlsExpiryDays < 0
            ? 'A configured TLS certificate has expired.'
            : `A configured TLS certificate expires in ${securityExpiry.tlsExpiryDays} day(s).`,
      link: '/security/tls',
      checkedAt,
    });
  }

  // `!== true` rather than `=== false`: `null` ("no backup exists at all
  // yet") is at least as much a problem as `false` ("one exists but is
  // unverified"), and must not be silently excluded just because it is a
  // different value — the same `!recentVerifiedBackupExists` convention
  // restore's pre-flight and the updates page already use for this exact
  // fact (both treat "never backed up" and "unverified" as one `false`).
  if (securityExpiry.lastBackupVerified !== true) {
    problems.push({
      id: 'no-recent-verified-backup',
      label: 'Backups',
      state: 'warning',
      message:
        securityExpiry.lastBackupAt === null
          ? 'No backup has ever been taken.'
          : 'No recent backup has been verified.',
      link: '/maintenance/backups',
      checkedAt,
    });
  }

  const tone = worstHealthState(problems.map((problem) => problem.state));
  const headline =
    problems.length === 0
      ? 'All systems healthy'
      : `${problems.length} item${problems.length === 1 ? '' : 's'} need attention`;

  return { tone, headline, problems };
}
