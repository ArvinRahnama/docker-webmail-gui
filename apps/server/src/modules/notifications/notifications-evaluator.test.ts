import { describe, expect, it } from 'vitest';
import type { DashboardResponse, DashboardSignal } from '@dwg/shared';
import { createDatabase, type Database } from '../../platform/db.js';
import { runMigrations, migrations } from '../../platform/migrations/index.js';
import { createLogger } from '../../platform/logger.js';
import { evaluateNotificationsOnce } from './notifications-evaluator.js';
import { NOTIFICATION_DEDUPE_KEYS, NOTIFICATION_SOURCES } from './notification-sources.js';
import { NotificationsRepository } from './notifications.repository.js';

function setUpDb(): Database {
  const db = createDatabase(':memory:');
  runMigrations(db, migrations);
  return db;
}

function silentLogger() {
  return createLogger({ level: 'silent' });
}

/** A snapshot-returning stub — `evaluateNotificationsOnce` only ever calls `getSnapshot()`, per `NotificationsEvaluatorDeps`'s own narrowed type. */
function stubDashboardService(snapshot: DashboardResponse) {
  return { getSnapshot: async () => snapshot };
}

function signal(id: string, overrides: Partial<DashboardSignal> = {}): DashboardSignal {
  return {
    id,
    label: id,
    state: 'critical',
    message: `${id} is down`,
    link: null,
    checkedAt: '2026-08-22T09:00:00.000Z',
    ...overrides,
  };
}

function emptySnapshot(overrides: Partial<DashboardResponse> = {}): DashboardResponse {
  return {
    generatedAt: '2026-08-22T09:00:00.000Z',
    verdict: { tone: 'healthy', headline: 'All systems healthy', problems: [] },
    metrics: {
      queue: { state: 'ok', message: null, total: 0, deferred: 0, byQueue: null },
      spamBlocked: { collecting: true, windowHours: 24, count: null },
      storage: { state: 'ok', message: null, df: null },
      mail: { state: 'ok', message: null, mailboxCount: 0, aliasCount: 0, domainCount: 0 },
    },
    serviceHealth: [],
    securityExpiry: {
      tlsState: 'healthy',
      tlsExpiryDays: 100,
      lastBackupAt: null,
      lastBackupVerified: null,
      updateAvailable: null,
    },
    recentActivity: [],
    ...overrides,
  };
}

describe('NOTIFICATION_DEDUPE_KEYS — stays in sync with what buildVerdict can produce', () => {
  it('covers every id dashboard.service.ts documents as a possible verdict-problem or security-expiry source', () => {
    // Mirrors dashboard.service.ts's own signal ids exactly — see that
    // file's `collectServiceHealth`/`buildVerdict`. Kept here, rather than
    // imported, because a shared constant both modules imported from
    // would just move the "did anyone forget to update it" risk rather
    // than remove it; this test is the thing that actually catches drift.
    const expected = [
      'broker',
      'managed-container',
      'docker-daemon',
      'rspamd',
      'clamav',
      'fail2ban',
      'tls-cert-expiring',
      'no-recent-verified-backup',
      'update-available',
    ];
    expect([...NOTIFICATION_DEDUPE_KEYS].sort()).toEqual([...expected].sort());
  });
});

describe('evaluateNotificationsOnce', () => {
  it("upserts an active notification for every current verdict problem, using that source's fixed severity and the signal's own label/message", async () => {
    const db = setUpDb();
    const repository = new NotificationsRepository(db);
    const snapshot = emptySnapshot({
      verdict: {
        tone: 'critical',
        headline: '1 item needs attention',
        problems: [signal('broker', { label: 'Broker connectivity', message: 'ping failed' })],
      },
    });

    await evaluateNotificationsOnce({
      repository,
      dashboardService: stubDashboardService(snapshot),
      logger: silentLogger(),
    });

    const rows = repository.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      dedupeKey: 'broker',
      severity: NOTIFICATION_SOURCES['broker']!.severity,
      title: 'Broker connectivity',
      body: 'ping failed',
      resolvedAt: null,
    });
    db.close();
  });

  it('resolves a previously-active notification the moment its condition no longer appears in the snapshot', async () => {
    const db = setUpDb();
    const repository = new NotificationsRepository(db);
    const logger = silentLogger();

    await evaluateNotificationsOnce({
      repository,
      dashboardService: stubDashboardService(
        emptySnapshot({
          verdict: {
            tone: 'critical',
            headline: '1 item needs attention',
            problems: [signal('broker')],
          },
        }),
      ),
      logger,
    });
    expect(repository.list()[0]?.resolvedAt).toBeNull();

    await evaluateNotificationsOnce({
      repository,
      dashboardService: stubDashboardService(emptySnapshot()), // healthy again
      logger,
    });

    expect(repository.list()[0]?.resolvedAt).not.toBeNull();
    db.close();
  });

  it('treats update-available as its own source, separate from verdict.problems (info-level, never urgent)', async () => {
    const db = setUpDb();
    const repository = new NotificationsRepository(db);
    const logger = silentLogger();

    await evaluateNotificationsOnce({
      repository,
      dashboardService: stubDashboardService(
        emptySnapshot({
          securityExpiry: { ...emptySnapshot().securityExpiry, updateAvailable: true },
        }),
      ),
      logger,
    });

    const row = repository.list().find((r) => r.dedupeKey === 'update-available');
    expect(row).toBeDefined();
    expect(row?.severity).toBe('info');
    expect(row?.resolvedAt).toBeNull();

    // Registry becomes unreachable (Unknown) on the next tick — must
    // resolve, not stay active on stale information, and never be
    // conflated with "no update" (`false`) either.
    await evaluateNotificationsOnce({
      repository,
      dashboardService: stubDashboardService(
        emptySnapshot({
          securityExpiry: { ...emptySnapshot().securityExpiry, updateAvailable: null },
        }),
      ),
      logger,
    });
    expect(
      repository.list().find((r) => r.dedupeKey === 'update-available')?.resolvedAt,
    ).not.toBeNull();
    db.close();
  });

  it('never lets an unrelated condition drift out of sync: two independent problems are tracked independently', async () => {
    const db = setUpDb();
    const repository = new NotificationsRepository(db);
    const logger = silentLogger();

    await evaluateNotificationsOnce({
      repository,
      dashboardService: stubDashboardService(
        emptySnapshot({
          verdict: {
            tone: 'critical',
            headline: '2 items need attention',
            problems: [signal('broker'), signal('clamav')],
          },
        }),
      ),
      logger,
    });
    expect(repository.list().filter((r) => r.resolvedAt === null)).toHaveLength(2);

    // Only "broker" clears.
    await evaluateNotificationsOnce({
      repository,
      dashboardService: stubDashboardService(
        emptySnapshot({
          verdict: {
            tone: 'critical',
            headline: '1 item needs attention',
            problems: [signal('clamav')],
          },
        }),
      ),
      logger,
    });

    const rows = repository.list();
    expect(rows.find((r) => r.dedupeKey === 'broker')?.resolvedAt).not.toBeNull();
    expect(rows.find((r) => r.dedupeKey === 'clamav')?.resolvedAt).toBeNull();
    db.close();
  });
});
