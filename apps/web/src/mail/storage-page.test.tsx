import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { MailCapabilitiesResponse, QuotaListResponse } from '@dwg/shared';
import { StoragePage } from './storage-page';
import { fetchMailCapabilities, fetchQuotaReport } from '@/lib/mail-api';

vi.mock('@/lib/mail-api', () => ({
  fetchMailCapabilities: vi.fn(),
  fetchQuotaReport: vi.fn(),
}));

const SUPPORTED_CAPABILITIES: MailCapabilitiesResponse = {
  quotas: { supported: true, reason: null },
  rspamd: { supported: false, reason: null },
  clamav: { supported: false, reason: null },
  fail2ban: { supported: false, reason: null },
  accountProvisioner: 'FILE',
  localAccountManagement: { supported: true, reason: null },
};

const UNSUPPORTED_CAPABILITIES: MailCapabilitiesResponse = {
  ...SUPPORTED_CAPABILITIES,
  quotas: {
    supported: false,
    reason: 'ENABLE_QUOTAS is not set (or is disabled) on this deployment.',
  },
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <StoragePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('StoragePage — renders from the capability document, not a guess (FEATURE_MATRIX.md §7)', () => {
  it('renders a real UnsupportedNotice, never an empty table, when the capability document says quotas are off', async () => {
    vi.mocked(fetchMailCapabilities).mockResolvedValue(UNSUPPORTED_CAPABILITIES);
    vi.mocked(fetchQuotaReport).mockResolvedValue({ entries: [] });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/ENABLE_QUOTAS/)).toBeInTheDocument();
    });
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    // The report itself must never even be requested once we already know
    // it is unsupported — nothing to show, nothing to fetch.
    expect(fetchQuotaReport).not.toHaveBeenCalled();
  });

  it('renders the usage table when the capability document says quotas are on', async () => {
    vi.mocked(fetchMailCapabilities).mockResolvedValue(SUPPORTED_CAPABILITIES);
    const report: QuotaListResponse = {
      entries: [
        {
          email: 'user@example.com',
          domain: 'example.com',
          quota: '1G',
          usage: {
            available: true,
            storageBytesUsed: 500_000_000,
            storageBytesLimit: 1_073_741_824,
            messageCountUsed: 10,
            messageCountLimit: null,
          },
          percentUsed: 0.47,
        },
      ],
    };
    vi.mocked(fetchQuotaReport).mockResolvedValue(report);

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('table')).toBeInTheDocument();
    });
    expect(screen.getByText('user@example.com')).toBeInTheDocument();
    expect(screen.queryByText(/ENABLE_QUOTAS/)).not.toBeInTheDocument();
  });
});
