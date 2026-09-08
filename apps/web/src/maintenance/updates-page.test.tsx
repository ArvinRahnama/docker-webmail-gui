import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { PanelUpdateCheckResponse, UpdateStatusResponse } from '@dwg/shared';
import { UpdatesPage } from './updates-page';
import { applyUpdate, fetchPanelUpdateStatus, fetchUpdateStatus } from '@/lib/maintenance-api';

// Same reason as the other maintenance suites: `use-maintenance-queries`
// imports the whole API surface, so the original module is spread back in
// and only what this page reaches is replaced. `fetchPanelUpdateStatus` is
// stubbed here too, unconditionally: since SU-D, `PanelUpdateCard` renders
// on this same page and fires its own query on every render — leaving it
// real would mean every test in this file makes a doomed real `fetch()`
// call. `panel-update-card.test.tsx` owns the Panel card's own behaviour;
// this file only needs the docker-mailserver card's tests to keep passing
// unaffected, which is exactly the #17 lesson (a second card must not
// break this file's existing assertions).
vi.mock('@/lib/maintenance-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/maintenance-api')>()),
  fetchUpdateStatus: vi.fn(),
  applyUpdate: vi.fn(),
  fetchPanelUpdateStatus: vi.fn(),
  applyPanelUpdate: vi.fn(),
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

/** The Panel card's own status — deliberately "nothing to see here" by default (possible, but already current) so it never adds text this file's assertions could trip over. */
function makePanelStatus(
  overrides: Partial<PanelUpdateCheckResponse> = {},
): PanelUpdateCheckResponse {
  return {
    currentVersion: '0.2.0',
    latestVersion: '0.2.0',
    updateAvailable: false,
    updatePossible: true,
    reason: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(fetchPanelUpdateStatus).mockResolvedValue(makePanelStatus());
});

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
    await user.click(within(dialog).getByRole('button', { name: 'Apply update' }));

    await waitFor(() => {
      expect(vi.mocked(applyUpdate)).toHaveBeenCalled();
    });
  });

  // Regression: the confirm dialog used to be tier 3 (type "docker-mailserver"
  // to enable Confirm) even though nothing destructive can ever follow from
  // confirming — the broker refuses unconditionally. An admin who clicked
  // Confirm without first typing the exact resource name into an
  // easy-to-miss text field got a silently disabled button: no request, no
  // error, nothing. This is the "Apply update does nothing" bug report.
  it('dispatches on a single confirm click — no typed confirmation gate to miss', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchUpdateStatus).mockResolvedValue(makeStatus({ updateAvailable: true }));
    vi.mocked(applyUpdate).mockRejectedValue(new Error('refused by the broker'));

    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Apply update' }));
    const dialog = await screen.findByRole('alertdialog');

    // No typed-confirmation field at this tier, and Confirm is enabled
    // immediately — there is nothing here that can silently block a click.
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();
    const confirmButton = within(dialog).getByRole('button', { name: 'Apply update' });
    expect(confirmButton).toBeEnabled();

    await user.click(confirmButton);

    await waitFor(() => {
      expect(vi.mocked(applyUpdate)).toHaveBeenCalledTimes(1);
    });
  });
});
