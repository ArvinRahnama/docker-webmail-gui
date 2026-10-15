import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { McpConnectionSummary, McpSettingsResponse, McpStatusResponse } from '@dwg/shared';
import { McpConnectionsPage } from './mcp-connections-page';
import { OneTimeCredentialDialog } from './one-time-credential-dialog';
import { CreateConnectionDialog } from './create-connection-dialog';
import {
  fetchMcpConnections,
  fetchMcpMailboxOverview,
  fetchMcpSettings,
  fetchMcpStatus,
} from '@/lib/mcp-api';
import { fetchMailboxes } from '@/lib/mail-api';

vi.mock('@/lib/mcp-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/mcp-api')>()),
  fetchMcpStatus: vi.fn(),
  fetchMcpConnections: vi.fn(),
  fetchMcpSettings: vi.fn(),
  fetchMcpMailboxOverview: vi.fn(),
}));
vi.mock('@/lib/mail-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/mail-api')>()),
  fetchMailboxes: vi.fn(),
}));

function wrap(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const deployedStatus: McpStatusResponse = {
  deployed: true,
  reason: null,
  service: {
    version: '1.0.2',
    controlProtocolVersion: 1,
    uptimeSeconds: 10,
    enabled: true,
    publicBaseUrl: 'https://mcp.example.com',
    issuer: 'https://mcp.example.com',
    vault: 'ok',
    mailBackend: 'imap',
    counts: { total: 2, pending: 1, active: 1, disabled: 0, suspended: 0, expired: 0, revoked: 0 },
    recentEvents: [],
    recentFailures: [],
  },
};

function connection(overrides: Partial<McpConnectionSummary>): McpConnectionSummary {
  return {
    id: 'c0123456789abcdefghjkmnpqr',
    label: 'ChatGPT — sales',
    mailbox: 'sales@example.com',
    mcpUrl: 'https://mcp.example.com/mcp/c0123456789abcdefghjkmnpqr',
    permissions: ['mail.read', 'mail.send', 'mail.delete'],
    status: 'active',
    statusReason: null,
    enrollment: {
      username: 'mcp-abc',
      state: 'consumed',
      issuedAt: null,
      expiresAt: null,
      consumedAt: null,
      failedAttempts: 0,
    },
    credentialHealth: 'healthy',
    senderIdentities: [],
    activeGrantCount: 1,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    expiresAt: null,
    lastAuthorizedAt: null,
    lastUsedAt: null,
    ...overrides,
  };
}

const settings: McpSettingsResponse = {
  issuer: 'https://mcp.example.com',
  warnings: [],
  settings: {
    enabled: true,
    publicBaseUrl: 'https://mcp.example.com',
    mail: {
      imapHost: 'mailserver',
      imapPort: 993,
      imapSecurity: 'tls',
      smtpHost: 'mailserver',
      smtpPort: 465,
      smtpSecurity: 'tls',
      tlsServername: null,
      tlsVerify: true,
    },
    setupCredentialTtlHours: 24,
    connectionExpiryDays: null,
    defaultPermissions: ['mail.read', 'mail.send', 'mail.delete'],
    maxConnectionsPerMailbox: 5,
    auditRetentionDays: 180,
    accessTokenTtlMinutes: 15,
    refreshTokenTtlDays: 30,
    rateLimits: {
      toolCallsPerMinute: 60,
      sendsPerHour: 20,
      sendsPerDay: 100,
      maxRecipientsPerMessage: 20,
    },
    maxAttachmentBytes: 10485760,
    saveSentCopies: true,
    clientRegistration: {
      dynamicRegistration: true,
      metadataDocuments: true,
      allowedMetadataHosts: [],
    },
  },
};

beforeEach(() => {
  vi.mocked(fetchMcpSettings).mockResolvedValue(settings);
  vi.mocked(fetchMailboxes).mockResolvedValue({
    mailboxes: [
      {
        email: 'sales@example.com',
        domain: 'example.com',
        quota: null,
        restricted: { send: false, receive: false },
      },
    ],
    page: 1,
    pageSize: 50,
    total: 1,
    unparseableLines: 0,
  } as never);
});

describe('MCP Connections page', () => {
  it('says plainly when the MCP service is not deployed, and offers no actions', async () => {
    vi.mocked(fetchMcpStatus).mockResolvedValue({
      deployed: false,
      reason: 'The MCP integration is not enabled on this install (MCP_ENABLED is off).',
      service: null,
    });
    wrap(<McpConnectionsPage />);
    expect(await screen.findByText(/not enabled on this install/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /generate connection/i })).not.toBeInTheDocument();
    expect(fetchMcpConnections).not.toHaveBeenCalled();
  });

  it('shows real counts and connections; a never-used connection reads "Never", not an invented time', async () => {
    vi.mocked(fetchMcpStatus).mockResolvedValue(deployedStatus);
    vi.mocked(fetchMcpConnections).mockResolvedValue({
      connections: [
        connection({}),
        connection({
          id: 'c1123456789abcdefghjkmnpqr',
          mailbox: 'support@example.com',
          status: 'pending',
          label: 'Support',
        }),
      ],
    });
    wrap(<McpConnectionsPage />);
    expect(await screen.findByText('sales@example.com')).toBeInTheDocument();
    expect(screen.getByText('support@example.com')).toBeInTheDocument();
    expect(screen.getAllByText('Awaiting authorization').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Never').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /generate connection/i })).toBeEnabled();
  });
});

describe('one-time credential dialog', () => {
  it('shows the setup password once and cannot be dismissed until the postmaster acknowledges', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { rerender } = wrap(
      <OneTimeCredentialDialog
        title="Connection generated"
        credential={{
          username: 'mcp-abc123',
          setupPassword: 'ACDEF-GHJKM-NPQRT-UVWXY-34679-ACDEF',
          expiresAt: '2026-10-16T10:00:00.000Z',
        }}
        mailbox="sales@example.com"
        mcpUrl="https://mcp.example.com/mcp/c0123"
        permissions={['mail.read', 'mail.send']}
        onClose={onClose}
      />,
    );
    expect(screen.getByText('ACDEF-GHJKM-NPQRT-UVWXY-34679-ACDEF')).toBeInTheDocument();
    expect(screen.getByText(/cannot be viewed again/)).toBeInTheDocument();
    const done = screen.getByRole('button', { name: 'Done' });
    expect(done).toBeDisabled();
    await user.click(screen.getByRole('checkbox'));
    expect(done).toBeEnabled();
    await user.click(done);
    expect(onClose).toHaveBeenCalledOnce();

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <OneTimeCredentialDialog
            title="x"
            credential={null}
            mailbox="sales@example.com"
            mcpUrl={null}
            permissions={[]}
            onClose={onClose}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.queryByText('ACDEF-GHJKM-NPQRT-UVWXY-34679-ACDEF')).not.toBeInTheDocument(),
    );
  });
});

describe('create connection dialog', () => {
  it('defaults Read, Send and Delete on, warns about send/delete, and requires the mailbox password when none is provisioned', async () => {
    vi.mocked(fetchMcpMailboxOverview).mockResolvedValue({ binding: null, connections: [] });
    wrap(
      <CreateConnectionDialog
        open
        onOpenChange={() => undefined}
        initialMailbox="sales@example.com"
        onCreated={() => undefined}
      />,
    );
    expect(await screen.findByLabelText('Read and search messages')).toBeChecked();
    expect(screen.getByLabelText('Send messages as this mailbox')).toBeChecked();
    expect(screen.getByLabelText('Move messages to Trash (and restore them)')).toBeChecked();
    expect(screen.getByText(/send email as this mailbox/)).toBeInTheDocument();
    expect(screen.getByText(/never permanent deletion/)).toBeInTheDocument();
    expect(await screen.findByLabelText('Mailbox password')).toBeInTheDocument();
  });

  it('does not ask for the mailbox password when a verified credential is already stored', async () => {
    vi.mocked(fetchMcpMailboxOverview).mockResolvedValue({
      binding: {
        mailbox: 'sales@example.com',
        credentialHealth: 'healthy',
        credentialProvisionedAt: null,
        lastVerifiedAt: null,
        lastError: null,
      },
      connections: [],
    });
    wrap(
      <CreateConnectionDialog
        open
        onOpenChange={() => undefined}
        initialMailbox="sales@example.com"
        onCreated={() => undefined}
      />,
    );
    expect(await screen.findByText('Verified')).toBeInTheDocument();
    expect(screen.queryByLabelText('Mailbox password')).not.toBeInTheDocument();
  });
});
