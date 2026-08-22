import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { DashboardResponse } from '@dwg/shared';
import { DashboardPage } from './dashboard-page';
import { fetchDashboard } from '@/lib/dashboard-api';

vi.mock('@/lib/dashboard-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/dashboard-api')>()),
  fetchDashboard: vi.fn(),
}));

function makeSnapshot(overrides: Partial<DashboardResponse> = {}): DashboardResponse {
  return {
    generatedAt: '2026-08-22T09:00:00.000Z',
    verdict: { tone: 'healthy', headline: 'All systems healthy', problems: [] },
    metrics: {
      queue: { state: 'ok', message: null, total: 3, deferred: 1, byQueue: null },
      spamBlocked: { collecting: true, windowHours: 24, count: null },
      storage: {
        state: 'ok',
        message: null,
        df: {
          layersSizeBytes: 512_000_000,
          imagesCount: 4,
          containersCount: 2,
          volumesCount: 5,
          buildCacheBytes: 1_000_000,
        },
      },
      mail: { state: 'ok', message: null, mailboxCount: 12, aliasCount: 4, domainCount: 3 },
    },
    serviceHealth: [
      {
        id: 'broker',
        label: 'Broker connectivity',
        state: 'healthy',
        message: null,
        link: '/docker/health',
        checkedAt: '2026-08-22T09:00:00.000Z',
      },
    ],
    securityExpiry: {
      tlsState: 'healthy',
      tlsExpiryDays: 200,
      lastBackupAt: '2026-08-20T09:00:00.000Z',
      lastBackupVerified: true,
      updateAvailable: false,
    },
    recentActivity: [
      {
        id: 'al_1',
        occurredAt: '2026-08-22T08:55:00.000Z',
        actorLabel: 'admin@example.com',
        action: 'auth.login.success',
        target: null,
        result: 'success',
      },
    ],
    ...overrides,
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DashboardPage — the verdict (UX_ARCHITECTURE.md §6.1 Row 1)', () => {
  it('says "All systems healthy" when every signal is healthy and a recent backup is verified', async () => {
    vi.mocked(fetchDashboard).mockResolvedValue(makeSnapshot());
    renderPage();
    expect(await screen.findByText('All systems healthy')).toBeInTheDocument();
  });

  it('renders the real recent-activity feed, translated to a readable label', async () => {
    vi.mocked(fetchDashboard).mockResolvedValue(makeSnapshot());
    renderPage();
    expect(await screen.findByText('Signed in')).toBeInTheDocument();
    expect(screen.getByText('admin@example.com')).toBeInTheDocument();
  });
});

describe('DashboardPage — a subsystem down (M11 exit criterion: degraded-state rendering)', () => {
  it('renders the page, with the down subsystem named as a problem, when the broker is unreachable', async () => {
    vi.mocked(fetchDashboard).mockResolvedValue(
      makeSnapshot({
        verdict: {
          tone: 'critical',
          headline: '1 item needs attention',
          problems: [
            {
              id: 'broker',
              label: 'Broker connectivity',
              state: 'critical',
              message: 'The Docker broker did not respond to a ping.',
              link: '/docker/health',
              checkedAt: '2026-08-22T09:00:00.000Z',
            },
          ],
        },
        serviceHealth: [
          {
            id: 'broker',
            label: 'Broker connectivity',
            state: 'critical',
            message: 'The Docker broker did not respond to a ping.',
            link: '/docker/health',
            checkedAt: '2026-08-22T09:00:00.000Z',
          },
        ],
        metrics: {
          ...makeSnapshot().metrics,
          storage: { state: 'unknown', message: 'connection refused', df: null },
        },
      }),
    );

    renderPage();

    // The page renders — never a crash, never a blank page — and names
    // the real problem rather than showing a generic failure.
    expect(await screen.findByText('1 item needs attention')).toBeInTheDocument();
    // Appears twice — once in the verdict's own problem list, once in the
    // service-health list — both real renderings of the same signal.
    expect(screen.getAllByText('The Docker broker did not respond to a ping.')).toHaveLength(2);

    // The unrelated storage tile honestly reports Unknown, never a stale
    // or fabricated number (MetricTile's own `unknown` treatment).
    expect(screen.getByText('Unknown', { exact: false })).toBeInTheDocument();

    // Isolation, visible in the rendered page: mail counts (a different,
    // unaffected subsystem) still show their real numbers.
    expect(screen.getByText('12 / 3')).toBeInTheDocument();
  });

  it('never claims "up to date" or a numeric TLS expiry when those subsystems could not be checked', async () => {
    vi.mocked(fetchDashboard).mockResolvedValue(
      makeSnapshot({
        securityExpiry: {
          tlsState: 'unknown',
          tlsExpiryDays: null,
          lastBackupAt: null,
          lastBackupVerified: null,
          updateAvailable: null,
        },
      }),
    );

    renderPage();

    expect(await screen.findByText('Could not check')).toBeInTheDocument();
    expect(screen.getByText('No backup yet')).toBeInTheDocument();
    expect(screen.queryByText(/day\(s\) left/)).not.toBeInTheDocument();
  });
});
