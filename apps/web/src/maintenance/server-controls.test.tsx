import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ServerControls } from './server-controls';
import { toast } from 'sonner';
import { probePanelUptime, restartManagedContainer, restartPanel } from '@/lib/docker-api';

vi.mock('@/lib/docker-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/docker-api')>()),
  restartManagedContainer: vi.fn(),
  restartPanel: vi.fn(),
  probePanelUptime: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/** The process that was running before the click: hours of uptime. */
const OLD_UPTIME = 86_400;

function renderControls() {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ServerControls />
    </QueryClientProvider>,
  );
}

describe('ServerControls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function confirmPanelRestart(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'Restart panel' }));
    const dialog = await screen.findByRole('alertdialog', { name: /Restart the panel/ });
    await user.click(within(dialog).getByRole('button', { name: 'Restart panel' }));
  }

  it('confirms and calls the managed mail-server restart', async () => {
    vi.mocked(restartManagedContainer).mockResolvedValue();
    const user = userEvent.setup();
    renderControls();

    await user.click(screen.getByRole('button', { name: 'Restart mail server' }));
    const dialog = await screen.findByRole('alertdialog', { name: /Restart the mail server/ });
    await user.click(within(dialog).getByRole('button', { name: 'Restart' }));

    expect(restartManagedContainer).toHaveBeenCalledOnce();
    expect(restartPanel).not.toHaveBeenCalled();
  });

  it('panel restart: confirms, dispatches panel.restart, shows the reconnecting overlay, then clears once health responds', async () => {
    // Acknowledged = nothing dropped the request, i.e. the development fake
    // broker: the old process answering is the expected outcome there.
    vi.mocked(restartPanel).mockResolvedValue();
    vi.mocked(probePanelUptime).mockResolvedValue(OLD_UPTIME);
    const user = userEvent.setup();
    renderControls();

    await confirmPanelRestart(user);

    expect(restartPanel).toHaveBeenCalledOnce();
    // Overlay shown while the health poll runs.
    expect(
      await screen.findByRole('alertdialog', { name: /Restarting the panel/ }),
    ).toBeInTheDocument();

    // Once /api/v1/health answers, the overlay clears on its own.
    await waitFor(
      () =>
        expect(
          screen.queryByRole('alertdialog', { name: /Restarting the panel/ }),
        ).not.toBeInTheDocument(),
      { timeout: 6000 },
    );
    expect(probePanelUptime).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('The panel is back online.');
  }, 10_000);

  it('panel restart: a dropped request succeeds only once a new process answers', async () => {
    vi.mocked(restartPanel).mockRejectedValue(new TypeError('Failed to fetch'));
    vi.mocked(probePanelUptime)
      .mockResolvedValueOnce(OLD_UPTIME)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(0.5);
    const user = userEvent.setup();
    renderControls();

    await confirmPanelRestart(user);

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('The panel is back online.'), {
      timeout: 9000,
    });
    expect(probePanelUptime).toHaveBeenCalledTimes(3);
    expect(toast.error).not.toHaveBeenCalled();
  }, 12_000);

  it('panel restart: the old process still answering is reported as "did not restart", not success', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(restartPanel).mockRejectedValue(new TypeError('Failed to fetch'));
    vi.mocked(probePanelUptime).mockImplementation(() => Promise.resolve(OLD_UPTIME));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderControls();

    await confirmPanelRestart(user);
    await vi.advanceTimersByTimeAsync(95_000);

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/did not restart/)),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });
});
