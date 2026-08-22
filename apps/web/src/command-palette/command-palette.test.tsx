import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { CommandPalette } from './command-palette';
import { fetchAliases, fetchDomains, fetchMailboxes } from '@/lib/mail-api';

vi.mock('@/lib/mail-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/mail-api')>()),
  fetchDomains: vi.fn(),
  fetchMailboxes: vi.fn(),
  fetchAliases: vi.fn(),
}));

const navigateMock = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => navigateMock,
}));

// Every test that types into the palette fires both the domains and
// mailboxes queries (`command-palette.tsx`'s own live-search section) —
// defaulted to empty here so a test that only cares about one of the two
// doesn't have to stub the other just to silence React Query's
// "returned undefined" warning.
beforeEach(() => {
  vi.mocked(fetchDomains).mockResolvedValue({ domains: [] });
  vi.mocked(fetchMailboxes).mockResolvedValue({
    mailboxes: [],
    page: 1,
    pageSize: 5,
    total: 0,
    unparseableLines: 0,
  });
  vi.mocked(fetchAliases).mockResolvedValue({ aliases: [], unparseableLines: 0 });
});

function renderPalette() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <CommandPalette />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('CommandPalette — the visible trigger (UX_ARCHITECTURE.md §5.3)', () => {
  it('renders a real, clickable trigger, not just an undiscoverable keybinding', async () => {
    const user = userEvent.setup();
    renderPalette();

    await user.click(screen.getByRole('button', { name: /Search/ }));
    expect(await screen.findByPlaceholderText('Search or jump to…')).toBeInTheDocument();
  });
});

describe('CommandPalette — navigation only reaches real, routed pages', () => {
  it('lists every static section, and selecting an entry navigates there and nothing else', async () => {
    const user = userEvent.setup();
    renderPalette();

    await user.click(screen.getByRole('button', { name: /Search/ }));
    expect(await screen.findByText('Backups')).toBeInTheDocument();
    expect(screen.getByText('Containers')).toBeInTheDocument();

    await user.click(screen.getByText('Backups'));
    expect(navigateMock).toHaveBeenCalledWith('/maintenance/backups');

    // The dialog closes on selection — it does not linger over the page it just navigated away from.
    await waitFor(() =>
      expect(screen.queryByPlaceholderText('Search or jump to…')).not.toBeInTheDocument(),
    );
  });

  it('typing filters the static list down to matching entries only', async () => {
    const user = userEvent.setup();
    renderPalette();

    await user.click(screen.getByRole('button', { name: /Search/ }));
    await user.type(screen.getByPlaceholderText('Search or jump to…'), 'backup');

    // The nav filter is debounced (SEARCH_DEBOUNCE_MS) alongside the live
    // entity search, so "Backups" being present proves nothing on its own
    // — it's in the unfiltered list too. Wait for the *absence* of a
    // non-matching entry, which only holds once filtering has applied.
    await waitFor(() => expect(screen.queryByText('Containers')).not.toBeInTheDocument());
    expect(screen.getByText('Backups')).toBeInTheDocument();
  });
});

describe('CommandPalette — live entity search reuses the real list endpoints', () => {
  it('finds a real domain by name and navigates to its real detail page', async () => {
    vi.mocked(fetchDomains).mockResolvedValue({
      domains: [{ domain: 'example.com', mailboxCount: 3, aliasCount: 1 } as never],
    });
    const user = userEvent.setup();
    renderPalette();

    await user.click(screen.getByRole('button', { name: /Search/ }));
    await user.type(screen.getByPlaceholderText('Search or jump to…'), 'example');

    const domainResult = await screen.findByText('example.com');
    await user.click(domainResult);
    expect(navigateMock).toHaveBeenCalledWith('/mail/domains/example.com');
  });

  it('calls the real mailboxes search endpoint with the typed query, not a client-side filter over an unbounded fetch', async () => {
    vi.mocked(fetchMailboxes).mockResolvedValue({
      mailboxes: [
        {
          email: 'alice@example.com',
          localPart: 'alice',
          domain: 'example.com',
          quota: null,
          restricted: { send: false, receive: false },
        },
      ],
      page: 1,
      pageSize: 5,
      total: 1,
      unparseableLines: 0,
    });
    const user = userEvent.setup();
    renderPalette();

    await user.click(screen.getByRole('button', { name: /Search/ }));
    await user.type(screen.getByPlaceholderText('Search or jump to…'), 'alice');

    await waitFor(() =>
      expect(fetchMailboxes).toHaveBeenCalledWith(
        expect.objectContaining({ search: 'alice', pageSize: 5 }),
      ),
    );
    const mailboxResult = await screen.findByText('alice@example.com');
    await user.click(mailboxResult);
    expect(navigateMock).toHaveBeenCalledWith('/mail/mailboxes/alice%40example.com');
  });

  it('finds a real alias and navigates to the aliases list pre-filtered to it — aliases have no per-item detail route to jump to instead', async () => {
    vi.mocked(fetchAliases).mockResolvedValue({
      aliases: [
        {
          id: 'sales@example.com',
          address: 'sales@example.com',
          isCatchAll: false,
          domain: 'example.com',
          recipients: ['bob@example.com'],
          type: 'internal',
        },
      ],
      unparseableLines: 0,
    });
    const user = userEvent.setup();
    renderPalette();

    await user.click(screen.getByRole('button', { name: /Search/ }));
    await user.type(screen.getByPlaceholderText('Search or jump to…'), 'sales');

    await waitFor(() =>
      expect(fetchAliases).toHaveBeenCalledWith(expect.objectContaining({ search: 'sales' })),
    );
    const aliasResult = await screen.findByText('sales@example.com');
    await user.click(aliasResult);
    expect(navigateMock).toHaveBeenCalledWith('/mail/aliases?search=sales%40example.com');
  });
});
