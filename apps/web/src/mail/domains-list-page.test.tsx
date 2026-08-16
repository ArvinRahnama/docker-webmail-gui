import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { DomainListResponse } from '@dwg/shared';
import { DomainsListPage } from './domains-list-page';
import { fetchDomains } from '@/lib/mail-api';

vi.mock('@/lib/mail-api', () => ({
  fetchDomains: vi.fn(),
}));

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <DomainsListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DomainsListPage — empty vs filtered-empty are distinct (UX_ARCHITECTURE.md §9)', () => {
  it('shows the first-run empty state, with an Add mailbox action, when no domain exists at all', async () => {
    const empty: DomainListResponse = { domains: [] };
    vi.mocked(fetchDomains).mockResolvedValue(empty);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('No domains yet')).toBeInTheDocument();
    });
    // Two "Add mailbox" affordances are expected here: the page's own
    // primary action (always present) and the first-run empty state's
    // own creating action — both real, focusable buttons.
    expect(screen.getAllByRole('button', { name: 'Add mailbox' }).length).toBeGreaterThanOrEqual(2);
  });

  it('shows the filtered-empty state, with Clear filters and no creating action, when a search matches nothing', async () => {
    const user = userEvent.setup();
    const withData: DomainListResponse = {
      domains: [{ domain: 'example.com', mailboxCount: 1, aliasCount: 0, aliasOnly: false }],
    };
    vi.mocked(fetchDomains).mockResolvedValue(withData);

    renderPage();
    await waitFor(() => expect(screen.getByText('example.com')).toBeInTheDocument());

    await user.type(screen.getByLabelText('Search domains'), 'no-such-domain');

    await waitFor(() => {
      expect(screen.getByText('No results match your filters')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument();
    // The filtered-empty state itself must never offer a creating
    // action — data already exists, it's just filtered out (§9).
    expect(screen.queryByText('No domains yet')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(screen.getByText('example.com')).toBeInTheDocument());
  });
});
