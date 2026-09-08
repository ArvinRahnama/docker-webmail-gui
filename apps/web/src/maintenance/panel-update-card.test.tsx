import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { toast } from 'sonner';
import type { PanelUpdateCheckResponse, UpdateStatusResponse } from '@dwg/shared';
import { PanelUpdateCard, waitForPanelReconnect } from './panel-update-card';
import { ApiError } from '@/lib/api-client';
import { applyPanelUpdate, fetchPanelUpdateStatus, fetchUpdateStatus } from '@/lib/maintenance-api';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

// Same reason `updates-page.test.tsx` gives: the whole API surface is
// imported by `use-maintenance-queries`, so the original module is spread
// back in and only what this card reaches is replaced.
vi.mock('@/lib/maintenance-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/maintenance-api')>()),
  fetchPanelUpdateStatus: vi.fn(),
  applyPanelUpdate: vi.fn(),
  fetchPanelSelfUpdateLastResult: vi.fn(),
  fetchUpdateStatus: vi.fn(),
}));

function makePanelStatus(
  overrides: Partial<PanelUpdateCheckResponse> = {},
): PanelUpdateCheckResponse {
  return {
    currentVersion: '0.2.0',
    latestVersion: '0.3.0',
    updateAvailable: true,
    updatePossible: true,
    reason: null,
    ...overrides,
  };
}

function makeDmsStatus(overrides: Partial<UpdateStatusResponse> = {}): UpdateStatusResponse {
  return {
    current: { digest: 'sha256:aaaa', repoTags: ['mailserver/docker-mailserver:latest'] },
    available: null,
    updateAvailable: false,
    checkedAt: '2026-08-18T09:00:00.000Z',
    releaseNotesUrl: 'https://github.com/docker-mailserver/docker-mailserver/releases',
    recentVerifiedBackupExists: true,
    mostRecentVerifiedBackupAt: '2026-08-17T09:00:00.000Z',
    rollbackCaveat: 'Cannot undo everything.',
    ...overrides,
  };
}

function renderCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <PanelUpdateCard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('PanelUpdateCard — renders current vs latest', () => {
  it('shows both versions and "Newer release published" when one is available', async () => {
    vi.mocked(fetchPanelUpdateStatus).mockResolvedValue(makePanelStatus());
    vi.mocked(fetchUpdateStatus).mockResolvedValue(makeDmsStatus());

    renderCard();

    expect(await screen.findByText('Newer release published')).toBeInTheDocument();
    expect(screen.getByText('0.2.0')).toBeInTheDocument();
    expect(screen.getByText('0.3.0')).toBeInTheDocument();
  });

  it('shows "Running latest" when already current, and disables the apply button', async () => {
    vi.mocked(fetchPanelUpdateStatus).mockResolvedValue(
      makePanelStatus({ latestVersion: '0.2.0', updateAvailable: false }),
    );
    vi.mocked(fetchUpdateStatus).mockResolvedValue(makeDmsStatus());

    renderCard();

    expect(await screen.findByText('Running latest')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply panel update' })).toBeDisabled();
  });

  it('shows "Version unknown" and the broker\'s own reason when a recreate is not possible', async () => {
    vi.mocked(fetchPanelUpdateStatus).mockResolvedValue(
      makePanelStatus({
        currentVersion: null,
        updatePossible: false,
        updateAvailable: false,
        reason: 'Could not determine the currently running version from local image tags.',
      }),
    );
    vi.mocked(fetchUpdateStatus).mockResolvedValue(makeDmsStatus());

    renderCard();

    expect(await screen.findByText('Version unknown')).toBeInTheDocument();
    expect(
      screen.getByText(/Could not determine the currently running version/),
    ).toBeInTheDocument();
  });

  // SU-E (docs/design/self-update.md §9.8): a source-built install still
  // resolves a real version (the baked marker, not a possibly-":local"
  // image tag) — it is not "unknown" the way a pre-SU-E image is — but is
  // refused all the same, with its own distinct reason, and Apply must be
  // disabled either way.
  it('shows the source-built refusal reason verbatim and disables Apply, even though a version resolved', async () => {
    vi.mocked(fetchPanelUpdateStatus).mockResolvedValue(
      makePanelStatus({
        currentVersion: '0.3.0',
        latestVersion: '0.4.0',
        updatePossible: false,
        updateAvailable: false,
        reason:
          'Self-update is only available for registry-image installs; source-built installs update by rebuilding/redeploying.',
      }),
    );
    vi.mocked(fetchUpdateStatus).mockResolvedValue(makeDmsStatus());

    renderCard();

    expect(await screen.findByText('Version unknown')).toBeInTheDocument();
    expect(screen.getByText('0.3.0')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Self-update is only available for registry-image installs; source-built installs update by rebuilding/redeploying.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply panel update' })).toBeDisabled();
  });
});

describe('PanelUpdateCard — Tier 4 confirm (type-to-confirm + backup gate)', () => {
  it('opens with the target version as the type-to-confirm field and the verified-backup status', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchPanelUpdateStatus).mockResolvedValue(makePanelStatus());
    vi.mocked(fetchUpdateStatus).mockResolvedValue(
      makeDmsStatus({
        recentVerifiedBackupExists: true,
        mostRecentVerifiedBackupAt: '2026-08-17T09:00:00.000Z',
      }),
    );

    renderCard();
    await user.click(await screen.findByRole('button', { name: 'Apply panel update' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByRole('textbox')).toBeInTheDocument();
    expect(within(dialog).getAllByText(/0\.3\.0/).length).toBeGreaterThan(0);
    expect(within(dialog).getByText(/A recent verified backup exists/)).toBeInTheDocument();
    // Type-to-confirm gates the button, same as every other tier 3+ dialog.
    expect(within(dialog).getByRole('button', { name: 'Apply panel update' })).toBeDisabled();
  });

  it('shows the unverified-backup warning and requires the acknowledgement checkbox when none exists', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchPanelUpdateStatus).mockResolvedValue(makePanelStatus());
    vi.mocked(fetchUpdateStatus).mockResolvedValue(
      makeDmsStatus({ recentVerifiedBackupExists: false, mostRecentVerifiedBackupAt: null }),
    );

    renderCard();
    await user.click(await screen.findByRole('button', { name: 'Apply panel update' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/No recent verified backup is on record/)).toBeInTheDocument();
    await user.type(within(dialog).getByRole('textbox'), '0.3.0');
    // Typed correctly, but the backup acknowledgement is still unticked.
    expect(within(dialog).getByRole('button', { name: 'Apply panel update' })).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox'));
    expect(within(dialog).getByRole('button', { name: 'Apply panel update' })).toBeEnabled();
  });

  it('confirming dispatches the job (applyPanelUpdate) once the version is typed and the backup gate is satisfied', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchPanelUpdateStatus).mockResolvedValue(makePanelStatus());
    vi.mocked(fetchUpdateStatus).mockResolvedValue(
      makeDmsStatus({ recentVerifiedBackupExists: true }),
    );
    vi.mocked(applyPanelUpdate).mockResolvedValue('job_1');

    renderCard();
    await user.click(await screen.findByRole('button', { name: 'Apply panel update' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByRole('textbox'), '0.3.0');

    const confirmButton = within(dialog).getByRole('button', { name: 'Apply panel update' });
    expect(confirmButton).toBeEnabled();
    await user.click(confirmButton);

    await waitFor(() => {
      expect(vi.mocked(applyPanelUpdate)).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
  });
});

describe('PanelUpdateCard — the SU-C concurrency refusal is surfaced verbatim', () => {
  it("shows the server's own CONFLICT message as an error toast, not a generic one", async () => {
    const user = userEvent.setup();
    vi.mocked(fetchPanelUpdateStatus).mockResolvedValue(makePanelStatus());
    vi.mocked(fetchUpdateStatus).mockResolvedValue(
      makeDmsStatus({ recentVerifiedBackupExists: true }),
    );
    const conflictMessage =
      'A backup or restore job (backup.create, bkp_123) is currently in flight. Wait for it to finish before starting a panel self-update.';
    vi.mocked(applyPanelUpdate).mockRejectedValue(
      new ApiError(
        { code: 'CONFLICT', message: conflictMessage, errorId: 'err_test', details: null },
        409,
      ),
    );

    renderCard();
    await user.click(await screen.findByRole('button', { name: 'Apply panel update' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByRole('textbox'), '0.3.0');
    await user.click(within(dialog).getByRole('button', { name: 'Apply panel update' }));

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(conflictMessage);
    });
    // The dialog closes either way — the admin sees the toast, not a stuck dialog.
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});

describe('waitForPanelReconnect — the bounded reconnect poll', () => {
  /** Instant, deterministic fakes — mirrors `apps/broker/src/self-update/updater.test.ts`'s own clock pattern; no real waiting anywhere in this suite. */
  function fakeClock() {
    let current = 0;
    return {
      now: () => current,
      delay: async (ms: number) => {
        current += ms;
      },
    };
  }

  it('resolves "target" as soon as the probe reports the target version', async () => {
    const clock = fakeClock();
    const probeVersion = vi.fn().mockResolvedValue('0.3.0');

    const outcome = await waitForPanelReconnect({
      targetVersion: '0.3.0',
      probeVersion,
      delay: clock.delay,
      now: clock.now,
      deadlineMs: 90_000,
      intervalMs: 1_500,
    });

    expect(outcome).toBe('target');
    expect(probeVersion).toHaveBeenCalledTimes(1);
  });

  it('resolves "other" immediately on a healthy-but-different version, without polling further (the rollback case)', async () => {
    const clock = fakeClock();
    const probeVersion = vi.fn().mockResolvedValue('0.2.0'); // the old version, e.g. after a rollback

    const outcome = await waitForPanelReconnect({
      targetVersion: '0.3.0',
      probeVersion,
      delay: clock.delay,
      now: clock.now,
      deadlineMs: 90_000,
      intervalMs: 1_500,
    });

    expect(outcome).toBe('other');
    expect(probeVersion).toHaveBeenCalledTimes(1);
  });

  it('resolves "timeout" once the deadline elapses with the panel never answering at all', async () => {
    const clock = fakeClock();
    const probeVersion = vi.fn().mockResolvedValue(null);

    const outcome = await waitForPanelReconnect({
      targetVersion: '0.3.0',
      probeVersion,
      delay: clock.delay,
      now: clock.now,
      deadlineMs: 5_000,
      intervalMs: 1_000,
    });

    expect(outcome).toBe('timeout');
    // Bounded, not unbounded: 5000ms / 1000ms interval means a handful of
    // probes, never an infinite loop.
    expect(probeVersion.mock.calls.length).toBeGreaterThan(0);
    expect(probeVersion.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it('picks the target version up after a few unhealthy probes, not only on the first', async () => {
    const clock = fakeClock();
    const probeVersion = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('0.3.0');

    const outcome = await waitForPanelReconnect({
      targetVersion: '0.3.0',
      probeVersion,
      delay: clock.delay,
      now: clock.now,
      deadlineMs: 90_000,
      intervalMs: 1_500,
    });

    expect(outcome).toBe('target');
    expect(probeVersion).toHaveBeenCalledTimes(3);
  });
});
