import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ConfigSetting, ConfigSnapshotSummary, ValidateConfigResponse } from '@dwg/shared';
import { ConfigPage } from './config-page';
import {
  applyConfig,
  fetchConfigSettings,
  fetchConfigSnapshots,
  revealConfigSetting,
  rollbackConfig,
  validateConfig,
} from '@/lib/maintenance-api';

vi.mock('@/lib/maintenance-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/maintenance-api')>()),
  fetchConfigSettings: vi.fn(),
  fetchConfigSnapshots: vi.fn(),
  revealConfigSetting: vi.fn(),
  validateConfig: vi.fn(),
  applyConfig: vi.fn(),
  rollbackConfig: vi.fn(),
}));

function makeSetting(overrides: Partial<ConfigSetting> = {}): ConfigSetting {
  return {
    key: 'LOG_LEVEL',
    label: 'Log level',
    description: 'How much the panel writes to its log.',
    classification: 'needs-restart',
    secret: false,
    masked: false,
    value: 'info',
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<ConfigSnapshotSummary> = {}): ConfigSnapshotSummary {
  return {
    id: 'snapshot-1',
    createdAt: '2026-08-18T09:00:00.000Z',
    createdByAdminId: 'admin-1',
    createdByLabel: 'admin@example.com',
    ...overrides,
  };
}

function makeValidation(overrides: Partial<ValidateConfigResponse> = {}): ValidateConfigResponse {
  return {
    valid: true,
    changes: [
      {
        key: 'LOG_LEVEL',
        allowed: true,
        reason: null,
        classification: 'needs-restart',
        currentValue: 'info',
        proposedValue: 'debug',
      },
    ],
    highestImpact: 'needs-restart',
    ...overrides,
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ConfigPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ConfigPage — nothing is sent while typing (FEATURE_MATRIX.md §28-29)', () => {
  it('does not validate or apply on keystrokes', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchConfigSettings).mockResolvedValue([makeSetting()]);
    vi.mocked(fetchConfigSnapshots).mockResolvedValue([]);

    renderPage();

    const field = await screen.findByLabelText('Log level');
    await user.clear(field);
    await user.type(field, 'debug');

    expect(vi.mocked(validateConfig)).not.toHaveBeenCalled();
    expect(vi.mocked(applyConfig)).not.toHaveBeenCalled();
  });

  it('keeps Review disabled until a value actually differs', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchConfigSettings).mockResolvedValue([makeSetting()]);
    vi.mocked(fetchConfigSnapshots).mockResolvedValue([]);

    renderPage();

    const field = await screen.findByLabelText('Log level');
    expect(screen.getByRole('button', { name: /Review/ })).toBeDisabled();

    // Typed and then reverted to the current value is not a change.
    await user.clear(field);
    await user.type(field, 'debug');
    expect(screen.getByRole('button', { name: /1 change/ })).toBeEnabled();

    await user.clear(field);
    await user.type(field, 'info');
    expect(screen.getByRole('button', { name: /Review/ })).toBeDisabled();
  });

  it('sends exactly the changed keys to validate, and confirms the server’s diff', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchConfigSettings).mockResolvedValue([
      makeSetting(),
      makeSetting({ key: 'SESSION_IDLE_TTL_HOURS', label: 'Idle timeout', value: '8' }),
    ]);
    vi.mocked(fetchConfigSnapshots).mockResolvedValue([]);
    vi.mocked(validateConfig).mockResolvedValue(makeValidation());

    renderPage();

    const field = await screen.findByLabelText('Log level');
    await user.clear(field);
    await user.type(field, 'debug');
    await user.click(screen.getByRole('button', { name: /1 change/ }));

    await waitFor(() => {
      expect(vi.mocked(validateConfig)).toHaveBeenCalledWith({ LOG_LEVEL: 'debug' });
    });

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('debug')).toBeInTheDocument();
  });
});

describe('ConfigPage — impact is explained before confirming', () => {
  it('states that applying stores the change rather than activating it', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchConfigSettings).mockResolvedValue([makeSetting()]);
    vi.mocked(fetchConfigSnapshots).mockResolvedValue([]);
    vi.mocked(validateConfig).mockResolvedValue(makeValidation());

    renderPage();

    const field = await screen.findByLabelText('Log level');
    await user.clear(field);
    await user.type(field, 'debug');
    await user.click(screen.getByRole('button', { name: /1 change/ }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/it does not activate it/i)).toBeInTheDocument();
  });

  it('shows a refused key with its reason instead of hiding it', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchConfigSettings).mockResolvedValue([makeSetting()]);
    vi.mocked(fetchConfigSnapshots).mockResolvedValue([]);
    vi.mocked(validateConfig).mockResolvedValue(
      makeValidation({
        valid: false,
        changes: [
          {
            key: 'LOG_LEVEL',
            allowed: false,
            reason: 'LOG_LEVEL is not an editable setting.',
            classification: null,
            currentValue: null,
            proposedValue: 'debug',
          },
        ],
        highestImpact: null,
      }),
    );

    renderPage();

    const field = await screen.findByLabelText('Log level');
    await user.clear(field);
    await user.type(field, 'debug');
    await user.click(screen.getByRole('button', { name: /1 change/ }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('LOG_LEVEL is not an editable setting.')).toBeInTheDocument();
    expect(within(dialog).getByText(/Nothing will be applied/i)).toBeInTheDocument();
  });
});

describe('ConfigPage — secrets (SECURITY.md §7.6)', () => {
  it('never reveals a secret on load; revealing is an explicit action', async () => {
    vi.mocked(fetchConfigSettings).mockResolvedValue([
      makeSetting({
        key: 'COOKIE_SECRET',
        label: 'Cookie secret',
        secret: true,
        masked: true,
        value: null,
      }),
    ]);
    vi.mocked(fetchConfigSnapshots).mockResolvedValue([]);

    renderPage();

    expect(await screen.findByRole('button', { name: 'Reveal' })).toBeInTheDocument();
    expect(vi.mocked(revealConfigSetting)).not.toHaveBeenCalled();
  });

  it('lets a secret be replaced without revealing the old value first', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchConfigSettings).mockResolvedValue([
      makeSetting({
        key: 'COOKIE_SECRET',
        label: 'Cookie secret',
        secret: true,
        masked: true,
        value: null,
      }),
    ]);
    vi.mocked(fetchConfigSnapshots).mockResolvedValue([]);

    renderPage();

    await user.type(await screen.findByLabelText('Cookie secret'), 'new-secret');

    expect(vi.mocked(revealConfigSetting)).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /1 change/ })).toBeEnabled();
  });

  it('reveals only when asked, through the audited POST', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchConfigSettings).mockResolvedValue([
      makeSetting({
        key: 'COOKIE_SECRET',
        label: 'Cookie secret',
        secret: true,
        masked: true,
        value: null,
      }),
    ]);
    vi.mocked(fetchConfigSnapshots).mockResolvedValue([]);
    vi.mocked(revealConfigSetting).mockResolvedValue({ key: 'COOKIE_SECRET', value: 'hunter2' });

    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Reveal' }));

    await waitFor(() => {
      expect(vi.mocked(revealConfigSetting)).toHaveBeenCalledWith('COOKIE_SECRET');
    });
    expect(await screen.findByDisplayValue('hunter2')).toBeInTheDocument();
  });
});

describe('ConfigPage — read-only settings', () => {
  it('offers no field for a read-only setting, and says why', async () => {
    vi.mocked(fetchConfigSettings).mockResolvedValue([
      makeSetting({
        key: 'DMS_CONTAINER_NAME',
        label: 'Container name',
        classification: 'read-only',
        value: 'mailserver',
      }),
    ]);
    vi.mocked(fetchConfigSnapshots).mockResolvedValue([]);

    renderPage();

    expect(await screen.findByText('mailserver')).toBeInTheDocument();
    expect(screen.queryByLabelText('Container name')).not.toBeInTheDocument();
    expect(screen.getByText(/cannot be changed from the panel/i)).toBeInTheDocument();
  });
});

describe('ConfigPage — snapshots and rollback', () => {
  it('lists snapshots and rolls back through the same audited path', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchConfigSettings).mockResolvedValue([makeSetting()]);
    vi.mocked(fetchConfigSnapshots).mockResolvedValue([makeSnapshot()]);
    vi.mocked(rollbackConfig).mockResolvedValue({
      applied: ['LOG_LEVEL'],
      snapshotId: 'snapshot-2',
    });

    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Roll back' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByText(/Read-only keys in the snapshot are skipped/i),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Roll back' }));

    await waitFor(() => {
      expect(vi.mocked(rollbackConfig)).toHaveBeenCalledWith('snapshot-1');
    });
  });

  it('explains what a snapshot is for rather than showing an empty table', async () => {
    vi.mocked(fetchConfigSettings).mockResolvedValue([makeSetting()]);
    vi.mocked(fetchConfigSnapshots).mockResolvedValue([]);

    renderPage();

    expect(await screen.findByText(/No snapshots yet/i)).toBeInTheDocument();
  });
});

describe('ConfigPage — apply', () => {
  it('applies the reviewed change set and says a restart is still required', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchConfigSettings).mockResolvedValue([makeSetting()]);
    vi.mocked(fetchConfigSnapshots).mockResolvedValue([]);
    vi.mocked(validateConfig).mockResolvedValue(makeValidation());
    vi.mocked(applyConfig).mockResolvedValue({ applied: ['LOG_LEVEL'], snapshotId: 'snapshot-1' });

    renderPage();

    const field = await screen.findByLabelText('Log level');
    await user.clear(field);
    await user.type(field, 'debug');
    await user.click(screen.getByRole('button', { name: /1 change/ }));

    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }));

    await waitFor(() => {
      expect(vi.mocked(applyConfig)).toHaveBeenCalledWith({ LOG_LEVEL: 'debug' });
    });
  });

  it('surfaces a failed apply and keeps the edits', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchConfigSettings).mockResolvedValue([makeSetting()]);
    vi.mocked(fetchConfigSnapshots).mockResolvedValue([]);
    vi.mocked(validateConfig).mockResolvedValue(makeValidation());
    vi.mocked(applyConfig).mockRejectedValue(new Error('write failed'));

    renderPage();

    const field = await screen.findByLabelText('Log level');
    await user.clear(field);
    await user.type(field, 'debug');
    await user.click(screen.getByRole('button', { name: /1 change/ }));

    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }));

    await waitFor(() => {
      expect(vi.mocked(applyConfig)).toHaveBeenCalled();
    });
    expect(await screen.findByDisplayValue('debug')).toBeInTheDocument();
  });
});
