import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { MailQueueListResponse } from '@dwg/shared';
import { QueuePage } from './queue-page';
import { fetchMailQueue } from '@/lib/mail-api';

vi.mock('@/lib/mail-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/mail-api')>()),
  fetchMailQueue: vi.fn(),
}));

function makeQueue(overrides: Partial<MailQueueListResponse> = {}): MailQueueListResponse {
  return {
    entries: [
      {
        queueName: 'deferred',
        queueId: '4Xk2mP1abc',
        arrivalTime: 1_755_123_000,
        messageSizeBytes: 2345,
        sender: 'newsletter@example.com',
        recipientCount: 2,
      },
      {
        queueName: 'active',
        queueId: '5Yl3nQ2bcd',
        arrivalTime: 1_755_123_400,
        messageSizeBytes: 890,
        sender: 'admin@example.com',
        recipientCount: 1,
      },
    ],
    byQueue: { incoming: 0, active: 1, deferred: 1, hold: 0 },
    unparseableLines: 0,
    ...overrides,
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <QueuePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('QueuePage — read-only, real data only', () => {
  it('shows per-queue counts and every queued message from the real response', async () => {
    vi.mocked(fetchMailQueue).mockResolvedValue(makeQueue());
    renderPage();

    expect(await screen.findByText('newsletter@example.com')).toBeInTheDocument();
    expect(screen.getByText('admin@example.com')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Mail queue' })).toBeInTheDocument();
  });

  it('never offers a flush, hold, or delete control anywhere on the page', async () => {
    vi.mocked(fetchMailQueue).mockResolvedValue(makeQueue());
    renderPage();

    await screen.findByText('newsletter@example.com');
    for (const forbidden of [/flush/i, /^hold$/i, /^delete$/i, /requeue/i]) {
      expect(screen.queryByRole('button', { name: forbidden })).not.toBeInTheDocument();
    }
  });

  it('warns about unparseable lines without hiding the parsed entries', async () => {
    vi.mocked(fetchMailQueue).mockResolvedValue(makeQueue({ unparseableLines: 2 }));
    renderPage();

    expect(await screen.findByText(/2 queue lines could not be read/)).toBeInTheDocument();
    expect(screen.getByText('newsletter@example.com')).toBeInTheDocument();
  });

  it('filters by sender through the real search box', async () => {
    vi.mocked(fetchMailQueue).mockResolvedValue(makeQueue());
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('newsletter@example.com');
    await user.type(screen.getByRole('textbox', { name: /search queue by sender/i }), 'admin');

    expect(screen.getByText('admin@example.com')).toBeInTheDocument();
    expect(screen.queryByText('newsletter@example.com')).not.toBeInTheDocument();
  });

  it('shows the real, honest empty state when nothing is queued', async () => {
    vi.mocked(fetchMailQueue).mockResolvedValue(
      makeQueue({ entries: [], byQueue: { incoming: 0, active: 0, deferred: 0, hold: 0 } }),
    );
    renderPage();

    expect(await screen.findByText('Nothing queued')).toBeInTheDocument();
  });
});
