import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { UpdateStatusResponse } from '@dwg/shared';
import { UpdatesPage } from './updates-page';
import { applyUpdate, fetchUpdateStatus } from '@/lib/maintenance-api';

// Same reason as the other maintenance suites: `use-maintenance-queries`
// imports the whole API surface, so the original module is spread back in
// and only what this page reaches is replaced.
vi.mock('@/lib/maintenance-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/maintenance-api')>()),
  fetchUpdateStatus: vi.fn(),
  applyUpdate: vi.fn(),
}));

function makeStatus(overrides: Partial<UpdateStatusResponse> = {}): UpdateStatusResponse {
  return {
    current: { digest: 'sha256:aaaa', repoTags: ['mailserver/docker-mailserver:latest'] },
    available: { digest: 'sha256:aaaa', checkedAt: '2026-08-18T09:00:00.000Z' },
    updateAvailable: false,
    checkedAt: '2026-08-18T09:00:00.000Z',
    releaseNotesUrl: 'https://github.com/docker-mailserver/docker-mailserver/releases',
    recentVerifiedBackupExists: true,
    mostRecentVerifiedBackupAt: '2026-08-17T09:00:00.000Z',
    rollbackCaveat:
      'Rolling an update back is not a supported operation from this panel; restore from a backup instead.',
    ...overrides,
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <UpdatesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('UpdatesPage — the three-state verdict (the DNS-state discipline, AGENT_BRIEF.md §4)', () => {
  it('says "Up to date" only when both digests resolved and matched', async () => {
    vi.mocked(fetchUpdateStatus).mockResolvedValue(makeStatus());

    renderPage();

    expect(await screen.findByText('Up to date')).toBeInTheDocument();
  });

  it('says an update is available when the registry digest differs', async () => {
    vi.mocked(fetchUpdateStatus).mockResolvedValue(
      makeStatus({
        available: { digest: 'sha256:bbbb', checkedAt: '2026-08-18T09:00:00.000Z' },
        updateAvailable: true,
      }),
    );

    renderPage();

    expect(await screen.findByText('Update available')).toBeInTheDocument();
  });

  it('reports an unreachable registry as unknown, never as up to date', async () => {
    vi.mocked(fetchUpdateStatus).mockResolvedValue(
      makeStatus({ available: null, updateAvailable: false }),
    );

    renderPage();

    expect(await screen.findByText('Could not check')).toBeInTheDocument();
    expect(screen.queryByText('Up to date')).not.toBeInTheDocument();
    expect(screen.getByText(/registry could not be reached/i)).toBeInTheDocument();
  });

  it('renders an unresolvable running digest as prose rather than an empty value', async () => {
    vi.mocked(fetchUpdateStatus).mockResolvedValue(
      makeStatus({ current: { digest: null, repoTags: [] } }),
    );

    renderPage();

    expect(await screen.findByText('Could not be resolved')).toBeInTheDocument();
    expect(screen.getByText('None recorded')).toBeInTheDocument();
  });
});

describe('UpdatesPage — the rollback caveat is unconditional (IMPLEMENTATION_PLAN.md §2.2)', () => {
  it('shows the caveat even when no update is available', async () => {
    const status = makeStatus();
    vi.mocked(fetchUpdateStatus).mockResolvedValue(status);

    renderPage();

    expect(await screen.findByText(status.rollbackCaveat)).toBeInTheDocument();
  });

  it('names taking a backup as the next action when none is on record', async () => {
    vi.mocked(fetchUpdateStatus).mockResolvedValue(
      makeStatus({ recentVerifiedBackupExists: false, mostRecentVerifiedBackupAt: null }),
    );

    renderPage();

    expect(await screen.findByText(/No recent verified backup/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Take one first' })).toHaveAttribute(
      'href',
      '/maintenance/backups',
    );
  });
});

describe('UpdatesPage — applying is refused by the server, and says so', () => {
  it('states the recreation limitation before the admin can confirm', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchUpdateStatus).mockResolvedValue(makeStatus({ updateAvailable: true }));

    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Apply update' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByText(/broker cannot create or remove containers/i),
    ).toBeInTheDocument();
  });

  it('surfaces the server’s own refusal rather than a hard-coded message', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchUpdateStatus).mockResolvedValue(makeStatus({ updateAvailable: true }));
    vi.mocked(applyUpdate).mockRejectedValue(new Error('refused by the broker'));

    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Apply update' }));

    const dialog = await screen.findByRole('alertdialog');
    // Tier 3 — the resource name must be typed before Confirm is enabled.
    await user.type(within(dialog).getByRole('textbox'), 'docker-mailserver');
    await user.click(within(dialog).getByRole('button', { name: 'Apply update' }));

    await waitFor(() => {
      expect(vi.mocked(applyUpdate)).toHaveBeenCalled();
    });
  });
});
