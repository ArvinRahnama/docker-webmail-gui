import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ServerControls } from './server-controls';
import { pingHealth, restartManagedContainer, restartPanel } from '@/lib/docker-api';

vi.mock('@/lib/docker-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/docker-api')>()),
  restartManagedContainer: vi.fn(),
  restartPanel: vi.fn(),
  pingHealth: vi.fn(),
}));

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
    vi.mocked(restartPanel).mockResolvedValue();
    vi.mocked(pingHealth).mockResolvedValue(true);
    const user = userEvent.setup();
    renderControls();

    await user.click(screen.getByRole('button', { name: 'Restart panel' }));
    const dialog = await screen.findByRole('alertdialog', { name: /Restart the panel/ });
    await user.click(within(dialog).getByRole('button', { name: 'Restart panel' }));

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
    expect(pingHealth).toHaveBeenCalled();
  }, 10_000);
});
