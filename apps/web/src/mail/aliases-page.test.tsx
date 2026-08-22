import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { AliasListResponse, MailCapabilitiesResponse } from '@dwg/shared';
import { AliasesPage } from './aliases-page';
import { fetchAliases, fetchDomains, fetchMailCapabilities } from '@/lib/mail-api';

vi.mock('@/lib/mail-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/mail-api')>()),
  fetchMailCapabilities: vi.fn(),
  fetchDomains: vi.fn(),
  fetchAliases: vi.fn(),
}));

function makeCapabilities(): MailCapabilitiesResponse {
  return {
    quotas: { supported: true, reason: null },
    rspamd: { supported: false, reason: null },
    clamav: { supported: false, reason: null },
    fail2ban: { supported: false, reason: null },
    accountProvisioner: 'FILE',
    localAccountManagement: { supported: true, reason: null },
  };
}

function makeAliases(): AliasListResponse {
  return {
    aliases: [
      {
        id: 'alice@example.com',
        address: 'alice@example.com',
        isCatchAll: false,
        domain: 'example.com',
        recipients: ['alice.real@example.com'],
        type: 'external',
      },
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
  };
}

function renderPage(initialEntry: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(fetchMailCapabilities).mockResolvedValue(makeCapabilities());
  vi.mocked(fetchDomains).mockResolvedValue({ domains: [] });
  vi.mocked(fetchAliases).mockResolvedValue(makeAliases());
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AliasesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AliasesPage — ?search= seeds the landing filter (M11 command-palette alias quick-open)', () => {
  it('shows every alias when no search param is present', async () => {
    renderPage('/mail/aliases');
    expect(await screen.findByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('sales@example.com')).toBeInTheDocument();
  });

  it('pre-fills the search box from ?search= and filters the table to the match, without rewriting the URL into a two-way sync', async () => {
    renderPage('/mail/aliases?search=alice');

    const searchBox = await screen.findByRole('textbox', { name: /search/i });
    expect(searchBox).toHaveValue('alice');

    expect(await screen.findByText('alice@example.com')).toBeInTheDocument();
    expect(screen.queryByText('sales@example.com')).not.toBeInTheDocument();
  });
});
