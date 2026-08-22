import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { RspamdStatusResponse, RspamdTrendResponse } from '@dwg/shared';
import { RspamdPage } from './rspamd-page';
import {
  fetchRspamdStatus,
  fetchRspamdTrend,
  learnRspamdHam,
  learnRspamdSpam,
  setRspamdActionThreshold,
  setRspamdSymbolScore,
} from '@/lib/security-api';

vi.mock('@/lib/security-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/security-api')>()),
  fetchRspamdStatus: vi.fn(),
  fetchRspamdTrend: vi.fn(),
  setRspamdActionThreshold: vi.fn(),
  setRspamdSymbolScore: vi.fn(),
  learnRspamdSpam: vi.fn(),
  learnRspamdHam: vi.fn(),
}));

function makeStatus(overrides: Partial<RspamdStatusResponse> = {}): RspamdStatusResponse {
  return {
    capability: { supported: true, reason: null },
    reachable: true,
    error: null,
    stat: {
      scanned: 4821,
      learned: 312,
      hamCount: 4390,
      spamCount: 431,
      actions: { 'no action': 4390, reject: 56 },
    },
    symbols: [
      { name: 'BAYES_SPAM', score: 3.5, description: 'Likely spam', group: 'statistics' },
      { name: 'DKIM_VALID', score: -1, description: 'Valid DKIM', group: 'dkim' },
    ],
    actions: [
      { action: 'reject', score: 15 },
      { action: 'greylist', score: 4 },
    ],
    historyCaveat: "Rspamd's own /history is a 200-entry in-memory ring buffer.",
    ...overrides,
  };
}

function makeTrend(overrides: Partial<RspamdTrendResponse> = {}): RspamdTrendResponse {
  return { collecting: true, windowHours: 168, points: [], ...overrides };
}

beforeEach(() => {
  // Every render fires both queries unconditionally (hooks can't be
  // conditional) — defaulted here so a test that only cares about status
  // doesn't also have to stub the trend query just to silence React
  // Query's "returned undefined" warning.
  vi.mocked(fetchRspamdTrend).mockResolvedValue(makeTrend());
});

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <RspamdPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('RspamdPage — capability gating (M8 backend, no config editor)', () => {
  it('shows the real unsupported reason rather than a generic message when disabled', async () => {
    vi.mocked(fetchRspamdStatus).mockResolvedValue(
      makeStatus({ capability: { supported: false, reason: 'ENABLE_RSPAMD is not set.' } }),
    );
    renderPage();
    expect(await screen.findByText('ENABLE_RSPAMD is not set.')).toBeInTheDocument();
  });
});

describe('RspamdPage — statistics render from the real response, never fabricated', () => {
  it('shows scanned/learned/ham/spam counts and the raw action breakdown', async () => {
    vi.mocked(fetchRspamdStatus).mockResolvedValue(makeStatus());
    vi.mocked(fetchRspamdTrend).mockResolvedValue(makeTrend());
    renderPage();

    expect(await screen.findByText('4821')).toBeInTheDocument();
    expect(screen.getByText('431')).toBeInTheDocument();
    expect(screen.getByText(/no action:/)).toBeInTheDocument();
    expect(screen.getByText('56', { exact: false })).toBeInTheDocument(); // the "reject" action count
  });

  it('says "Collecting" until enough of our own samples exist, never draws a fabricated trend', async () => {
    vi.mocked(fetchRspamdStatus).mockResolvedValue(makeStatus());
    vi.mocked(fetchRspamdTrend).mockResolvedValue(makeTrend({ collecting: true }));
    renderPage();

    expect(await screen.findByText(/Collecting/)).toBeInTheDocument();
  });

  it('reports the controller as critical and shows the real error when unreachable, and hides the write controls entirely', async () => {
    vi.mocked(fetchRspamdStatus).mockResolvedValue(
      makeStatus({
        reachable: false,
        error: 'connection refused',
        stat: null,
        symbols: [],
        actions: [],
      }),
    );
    vi.mocked(fetchRspamdTrend).mockResolvedValue(makeTrend());
    renderPage();

    expect(await screen.findByText('connection refused')).toBeInTheDocument();
    expect(screen.queryByText('Train Bayes')).not.toBeInTheDocument();
    expect(screen.queryByText('Symbol scores')).not.toBeInTheDocument();
  });
});

describe('RspamdPage — the only allowed writes (FEATURE_MATRIX.md §15, SECURITY.md §3.13)', () => {
  it('saves an action threshold through the real endpoint, only once the value actually changed', async () => {
    vi.mocked(fetchRspamdStatus).mockResolvedValue(makeStatus());
    vi.mocked(fetchRspamdTrend).mockResolvedValue(makeTrend());
    vi.mocked(setRspamdActionThreshold).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();

    const input = await screen.findByRole('spinbutton', { name: 'Score for reject' });
    const row = input.closest('div') as HTMLElement;
    const saveButton = within(row).getByRole('button', { name: 'Save' });

    // Unchanged — Save stays disabled rather than allowing a no-op write.
    expect(saveButton).toBeDisabled();

    await user.clear(input);
    await user.type(input, '20');
    expect(saveButton).toBeEnabled();
    await user.click(saveButton);

    await waitFor(() => expect(setRspamdActionThreshold).toHaveBeenCalledWith('reject', 20));
  });

  it('saves a symbol score through the real endpoint', async () => {
    vi.mocked(fetchRspamdStatus).mockResolvedValue(makeStatus());
    vi.mocked(fetchRspamdTrend).mockResolvedValue(makeTrend());
    vi.mocked(setRspamdSymbolScore).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();

    const input = await screen.findByRole('spinbutton', { name: 'Score for BAYES_SPAM' });
    const row = input.closest('div') as HTMLElement;
    await user.clear(input);
    await user.type(input, '4.5');
    await user.click(within(row).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(setRspamdSymbolScore).toHaveBeenCalled());
    expect(vi.mocked(setRspamdSymbolScore).mock.calls[0]?.[0]).toBe('BAYES_SPAM');
    expect(vi.mocked(setRspamdSymbolScore).mock.calls[0]?.[1]).toBeCloseTo(4.5);
  });

  it('gates learn-spam behind a real Tier 2 confirmation before calling the real endpoint', async () => {
    vi.mocked(fetchRspamdStatus).mockResolvedValue(makeStatus());
    vi.mocked(fetchRspamdTrend).mockResolvedValue(makeTrend());
    vi.mocked(learnRspamdSpam).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();

    const textarea = await screen.findByLabelText('Message (raw, including headers)');
    await user.type(textarea, 'From: a@example.com\n\nBuy now!!!');
    await user.click(screen.getByRole('button', { name: 'Learn as spam' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(learnRspamdSpam).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Learn' }));

    await waitFor(() => expect(learnRspamdSpam).toHaveBeenCalled());
    // Only the first (real) argument — TanStack Query's mutate() also
    // passes an internal context object as a second argument, which the
    // real learnRspamdSpam(message: string) signature ignores.
    expect(vi.mocked(learnRspamdSpam).mock.calls[0]?.[0]).toBe('From: a@example.com\n\nBuy now!!!');
  });

  it('never calls learn-ham when learn-spam was confirmed, and vice versa', async () => {
    vi.mocked(fetchRspamdStatus).mockResolvedValue(makeStatus());
    vi.mocked(fetchRspamdTrend).mockResolvedValue(makeTrend());
    vi.mocked(learnRspamdHam).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();

    const textarea = await screen.findByLabelText('Message (raw, including headers)');
    await user.type(textarea, 'A real newsletter');
    await user.click(screen.getByRole('button', { name: 'Learn as ham' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Learn' }));

    await waitFor(() => expect(learnRspamdHam).toHaveBeenCalled());
    expect(learnRspamdSpam).not.toHaveBeenCalled();
  });
});
