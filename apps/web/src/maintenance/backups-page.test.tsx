import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type {
  BackupDestinationStatus,
  BackupSchedule,
  BackupSummary,
  RestorePreflightResponse,
} from '@dwg/shared';
import { BackupsPage } from './backups-page';
import {
  createBackup,
  deleteBackup,
  fetchBackupDestination,
  fetchBackupSchedule,
  fetchBackups,
  fetchRemoteBackups,
  fetchRestorePreflight,
  importRemoteBackup,
  restoreBackup,
  uploadBackup,
  verifyBackup,
} from '@/lib/maintenance-api';

// `use-maintenance-queries` imports the whole maintenance API surface, so
// the original module is spread back in and only the functions this page
// actually reaches are replaced — a bare factory would leave every other
// named import undefined at module-eval time.
vi.mock('@/lib/maintenance-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/maintenance-api')>()),
  fetchBackups: vi.fn(),
  createBackup: vi.fn(),
  verifyBackup: vi.fn(),
  deleteBackup: vi.fn(),
  fetchRestorePreflight: vi.fn(),
  restoreBackup: vi.fn(),
  fetchBackupDestination: vi.fn(),
  fetchBackupSchedule: vi.fn(),
  uploadBackup: vi.fn(),
  fetchRemoteBackups: vi.fn(),
  importRemoteBackup: vi.fn(),
}));

const S3_DESTINATION: BackupDestinationStatus = {
  type: 's3',
  configured: true,
  describe: 's3://bucket/backups',
  s3: {
    endpoint: 'https://s3.example.com',
    region: 'us-east-1',
    bucket: 'bucket',
    prefix: 'backups',
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKeySet: true,
  },
};

// The remote/schedule cards this page now renders each fetch their own state;
// default them to "nothing configured / off" so existing assertions about the
// backup list are unaffected. A test that cares sets its own values.
const NO_DESTINATION: BackupDestinationStatus = {
  type: 'none',
  configured: false,
  describe: null,
  s3: null,
};
const OFF_SCHEDULE: BackupSchedule = {
  frequency: 'off',
  enabled: false,
  mode: 'warm',
  retentionKeep: 3,
  retentionMaxAgeDays: null,
  uploadToRemote: false,
  lastRunAt: null,
  nextRunAt: null,
  updatedAt: '2026-09-02T00:00:00.000Z',
};

beforeEach(() => {
  vi.mocked(fetchBackupDestination).mockResolvedValue(NO_DESTINATION);
  vi.mocked(fetchBackupSchedule).mockResolvedValue(OFF_SCHEDULE);
});

function makeBackup(overrides: Partial<BackupSummary> & { readonly id: string }): BackupSummary {
  return {
    createdAt: '2026-08-18T09:00:00.000Z',
    createdByAdminId: 'admin-1',
    createdByLabel: 'admin@example.com',
    mode: 'warm',
    sizeBytes: 1024 * 1024 * 512,
    dmsImageDigest: 'sha256:aaaa',
    volumes: [
      { key: 'mail', entryCount: 120, sizeBytes: 1024 * 1024 * 480 },
      { key: 'mailState', entryCount: 20, sizeBytes: 1024 * 1024 * 20 },
      { key: 'mailLog', entryCount: 8, sizeBytes: 1024 * 1024 * 8 },
      { key: 'dmsConfig', entryCount: 14, sizeBytes: 1024 * 1024 * 4 },
    ],
    verificationStatus: 'unverified',
    verifiedAt: null,
    uploadStatus: 'pending',
    uploadDestination: null,
    uploadedAt: null,
    uploadError: null,
    localPresent: true,
    ...overrides,
  };
}

function makePreflight(
  backup: BackupSummary,
  overrides: Partial<RestorePreflightResponse> = {},
): RestorePreflightResponse {
  return {
    backup,
    containerRunning: false,
    currentDmsImageDigest: 'sha256:aaaa',
    manifestCompatible: true,
    compatibilityMessage: null,
    recentVerifiedBackupExists: false,
    mostRecentVerifiedBackupAt: null,
    vmailOwnershipNote: 'Restored files keep vmail ownership (5000:5000).',
    ...overrides,
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <BackupsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Opens the row action menu for the single backup rendered by the test. */
async function openRowMenu(user: ReturnType<typeof userEvent.setup>, backupId: string) {
  await user.click(screen.getByRole('button', { name: `Actions for backup ${backupId}` }));
}

describe('BackupsPage — list states (UX_ARCHITECTURE.md §9)', () => {
  it('shows the table loading state while the backup list is in flight', () => {
    vi.mocked(fetchBackups).mockReturnValue(new Promise(() => {}));

    renderPage();

    expect(screen.getByRole('status', { name: 'Loading table data' })).toBeInTheDocument();
  });

  it('shows the first-run empty state when no backup exists', async () => {
    vi.mocked(fetchBackups).mockResolvedValue([]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('No backups yet')).toBeInTheDocument();
    });
  });

  it('shows an error state with a retry action when the list cannot be loaded', async () => {
    vi.mocked(fetchBackups).mockRejectedValue(new Error('network down'));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Could not load the backup list.')).toBeInTheDocument();
    });
    // §2 principle 8 — the error names a next action rather than dead-ending.
    expect(screen.getByRole('button', { name: /retry|try again/i })).toBeInTheDocument();
  });

  it('shows created, size, contents and verification status for each backup', async () => {
    vi.mocked(fetchBackups).mockResolvedValue([
      makeBackup({
        id: 'backup-verified',
        verificationStatus: 'verified',
        verifiedAt: '2026-08-18T10:00:00.000Z',
      }),
      makeBackup({ id: 'backup-failed', verificationStatus: 'failed', mode: 'cold' }),
    ]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('backup-verified')).toBeInTheDocument();
    });
    expect(screen.getByText('Verified')).toBeInTheDocument();
    expect(screen.getByText('Verification failed')).toBeInTheDocument();
    expect(screen.getByText('Cold')).toBeInTheDocument();
    // Contents are named per volume, never a bare count.
    expect(screen.getAllByText('Mail data').length).toBeGreaterThan(0);
    expect(screen.getAllByText('512 MB').length).toBeGreaterThan(0);
  });
});

describe('BackupsPage — nothing is ever auto-selected', () => {
  it('offers no row selection at all, so no backup can be implicitly chosen', async () => {
    vi.mocked(fetchBackups).mockResolvedValue([
      makeBackup({ id: 'backup-old', createdAt: '2026-08-17T09:00:00.000Z' }),
      makeBackup({
        id: 'backup-latest',
        createdAt: '2026-08-18T09:00:00.000Z',
        verificationStatus: 'verified',
        verifiedAt: '2026-08-18T09:30:00.000Z',
      }),
    ]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('backup-latest')).toBeInTheDocument();
    });
    // No checkboxes, no pre-checked "latest", no implicit target for any
    // destructive action.
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('opens the create dialog with neither backup mode chosen and refuses until one is picked', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchBackups).mockResolvedValue([]);
    vi.mocked(createBackup).mockResolvedValue('job-create-1');

    renderPage();

    await user.click(screen.getByRole('button', { name: 'Create backup' }));
    const dialog = await screen.findByRole('dialog');

    const warm = within(dialog).getByRole('radio', { name: /Warm/ });
    const cold = within(dialog).getByRole('radio', { name: /Cold/ });
    expect(warm).not.toBeChecked();
    expect(cold).not.toBeChecked();

    // The caveat is stated at the point of choice, not hidden in docs.
    expect(within(dialog).getByText(/mail data is live while it is read/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/container is stopped first/i)).toBeInTheDocument();

    const submit = within(dialog).getByRole('button', { name: 'Create backup' });
    expect(submit).toBeDisabled();

    await user.click(cold);
    await user.click(within(dialog).getByRole('button', { name: 'Create backup' }));

    await waitFor(() => {
      expect(vi.mocked(createBackup)).toHaveBeenCalledWith('cold');
    });
  });
});

describe('BackupsPage — destructive actions live behind a menu (§8)', () => {
  it('offers no row-level delete control until the actions menu is opened', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchBackups).mockResolvedValue([makeBackup({ id: 'backup-1' })]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('backup-1')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();

    await openRowMenu(user, 'backup-1');

    expect(await screen.findByRole('menuitem', { name: 'Delete backup…' })).toBeInTheDocument();
  });

  it('downloads through a real anchor rather than a fetch', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchBackups).mockResolvedValue([makeBackup({ id: 'backup-1' })]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('backup-1')).toBeInTheDocument();
    });
    await openRowMenu(user, 'backup-1');

    const link = await screen.findByRole('menuitem', { name: /Download archive/ });
    expect(link).toHaveAttribute('href', '/api/v1/backups/backup-1/download');
  });

  it('starts a verification job from the menu', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchBackups).mockResolvedValue([makeBackup({ id: 'backup-1' })]);
    vi.mocked(verifyBackup).mockResolvedValue('job-verify-1');

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('backup-1')).toBeInTheDocument();
    });
    await openRowMenu(user, 'backup-1');
    await user.click(await screen.findByRole('menuitem', { name: 'Verify archive' }));

    await waitFor(() => {
      expect(vi.mocked(verifyBackup)).toHaveBeenCalledWith('backup-1');
    });
  });
});

describe('BackupsPage — Delete is tier 3 (§8)', () => {
  it('requires the backup id to be typed exactly, and never focuses the destructive button', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchBackups).mockResolvedValue([
      makeBackup({ id: 'backup-1', verificationStatus: 'verified', verifiedAt: null }),
    ]);
    vi.mocked(deleteBackup).mockResolvedValue(undefined);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('backup-1')).toBeInTheDocument();
    });
    await openRowMenu(user, 'backup-1');
    await user.click(await screen.findByRole('menuitem', { name: 'Delete backup…' }));

    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: 'Delete backup' });

    // Tier 3 = type-to-confirm + impact summary, destructive button not focused.
    expect(confirm).toBeDisabled();
    expect(confirm).not.toHaveFocus();
    expect(within(dialog).getByText(/Permanently deletes the/)).toBeInTheDocument();
    // A verified backup says so — the shared verified-backup gate elsewhere
    // depends on it.
    expect(within(dialog).getByText(/no recent verified backup/i)).toBeInTheDocument();

    const input = within(dialog).getByRole('textbox');
    await user.type(input, 'backup-wrong');
    expect(confirm).toBeDisabled();

    await user.clear(input);
    await user.type(input, 'backup-1');
    expect(confirm).toBeEnabled();

    await user.click(confirm);
    await waitFor(() => {
      expect(vi.mocked(deleteBackup)).toHaveBeenCalledWith('backup-1');
    });
  });
});

describe('BackupsPage — Restore is tier 4 (§8)', () => {
  it('requires BOTH the typed backup id AND the backup gate before it will restore', async () => {
    const user = userEvent.setup();
    const backup = makeBackup({ id: 'backup-1' });
    vi.mocked(fetchBackups).mockResolvedValue([backup]);
    // No recent verified backup of the *current* data => the gate must be
    // satisfied by an explicit acknowledgement.
    vi.mocked(fetchRestorePreflight).mockResolvedValue(
      makePreflight(backup, { recentVerifiedBackupExists: false }),
    );
    vi.mocked(restoreBackup).mockResolvedValue('job-restore-1');

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('backup-1')).toBeInTheDocument();
    });
    await openRowMenu(user, 'backup-1');
    await user.click(await screen.findByRole('menuitem', { name: 'Restore from this backup…' }));

    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: 'Restore' });
    expect(confirm).toBeDisabled();
    expect(confirm).not.toHaveFocus();

    // The pre-flight is real, from the server, including its own ownership note.
    await waitFor(() => {
      expect(
        within(dialog).getByText('Restored files keep vmail ownership (5000:5000).'),
      ).toBeInTheDocument();
    });
    expect(vi.mocked(fetchRestorePreflight)).toHaveBeenCalledWith('backup-1');

    // Typed confirmation alone is not enough.
    await user.type(within(dialog).getByRole('textbox'), 'backup-1');
    expect(confirm).toBeDisabled();

    // The gate alone is not enough either — clear the typed name to prove it.
    const acknowledgement = within(dialog).getByRole('checkbox');
    await user.click(acknowledgement);
    expect(confirm).toBeEnabled();

    await user.clear(within(dialog).getByRole('textbox'));
    expect(confirm).toBeDisabled();

    await user.type(within(dialog).getByRole('textbox'), 'backup-1');
    await user.click(confirm);

    await waitFor(() => {
      expect(vi.mocked(restoreBackup)).toHaveBeenCalledWith('backup-1', {
        confirm: true,
        acknowledgeNoRecentBackup: true,
      });
    });
  });

  it('does not ask for an acknowledgement when a recent verified backup already exists, and says so', async () => {
    const user = userEvent.setup();
    const backup = makeBackup({ id: 'backup-1' });
    vi.mocked(fetchBackups).mockResolvedValue([backup]);
    vi.mocked(fetchRestorePreflight).mockResolvedValue(
      makePreflight(backup, {
        recentVerifiedBackupExists: true,
        mostRecentVerifiedBackupAt: '2026-08-18T08:00:00.000Z',
      }),
    );
    vi.mocked(restoreBackup).mockResolvedValue('job-restore-1');

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('backup-1')).toBeInTheDocument();
    });
    await openRowMenu(user, 'backup-1');
    await user.click(await screen.findByRole('menuitem', { name: 'Restore from this backup…' }));

    const dialog = await screen.findByRole('alertdialog');
    await waitFor(() => {
      expect(within(dialog).getByText(/A recent verified backup/)).toBeInTheDocument();
    });
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();

    await user.type(within(dialog).getByRole('textbox'), 'backup-1');
    await user.click(within(dialog).getByRole('button', { name: 'Restore' }));

    // The flag mirrors the pre-flight rather than being hardcoded either way.
    await waitFor(() => {
      expect(vi.mocked(restoreBackup)).toHaveBeenCalledWith('backup-1', {
        confirm: true,
        acknowledgeNoRecentBackup: false,
      });
    });
  });

  it('refuses to restore while the container is running, and says why', async () => {
    const user = userEvent.setup();
    const backup = makeBackup({ id: 'backup-1' });
    vi.mocked(fetchBackups).mockResolvedValue([backup]);
    vi.mocked(fetchRestorePreflight).mockResolvedValue(
      makePreflight(backup, { containerRunning: true, recentVerifiedBackupExists: true }),
    );

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('backup-1')).toBeInTheDocument();
    });
    await openRowMenu(user, 'backup-1');
    await user.click(await screen.findByRole('menuitem', { name: 'Restore from this backup…' }));

    const dialog = await screen.findByRole('alertdialog');
    await waitFor(() => {
      expect(within(dialog).getByText(/still running/i)).toBeInTheDocument();
    });

    await user.type(within(dialog).getByRole('textbox'), 'backup-1');
    await user.click(within(dialog).getByRole('button', { name: 'Restore' }));

    // The gate is a refusal, not a warning — nothing is sent.
    await waitFor(() => {
      expect(vi.mocked(restoreBackup)).not.toHaveBeenCalled();
    });
  });
});

describe('BackupsPage — Restore is withheld on mobile, visibly (§8)', () => {
  it('states in words that restore needs a larger screen, rather than silently omitting it', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchBackups).mockResolvedValue([makeBackup({ id: 'backup-1' })]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('backup-1')).toBeInTheDocument();
    });
    // The page-level explanation is present in the DOM (CSS decides which
    // breakpoint sees it) — the omission is never silent.
    expect(screen.getByText(/Restore is not available on a screen this small/)).toBeInTheDocument();

    await openRowMenu(user, 'backup-1');
    const disabled = await screen.findByRole('menuitem', {
      name: 'Restore — needs a larger screen',
    });
    expect(disabled).toHaveAttribute('data-disabled');
  });
});

describe('BackupsPage — remote destination (M13)', () => {
  it('renders the per-backup upload status and the remote-only hint', async () => {
    vi.mocked(fetchBackups).mockResolvedValue([
      makeBackup({ id: 'backup-remote', uploadStatus: 'uploaded', localPresent: false }),
    ]);

    renderPage();

    await waitFor(() => expect(screen.getByText('backup-remote')).toBeInTheDocument());
    expect(screen.getByText('Uploaded')).toBeInTheDocument();
    expect(screen.getByText('Remote only')).toBeInTheDocument();
  });

  it('offers "Upload to remote" only when a destination is configured, and starts an upload job', async () => {
    vi.mocked(fetchBackupDestination).mockResolvedValue(S3_DESTINATION);
    vi.mocked(fetchBackups).mockResolvedValue([
      makeBackup({ id: 'backup-1', uploadStatus: 'pending', localPresent: true }),
    ]);
    vi.mocked(uploadBackup).mockResolvedValue('job-upload-1');
    const user = userEvent.setup();

    renderPage();

    await waitFor(() => expect(screen.getByText('backup-1')).toBeInTheDocument());
    await openRowMenu(user, 'backup-1');
    await user.click(await screen.findByRole('menuitem', { name: 'Upload to remote' }));

    await waitFor(() => expect(vi.mocked(uploadBackup)).toHaveBeenCalledWith('backup-1'));
  });

  it('browses the remote and imports a backup that is not already local', async () => {
    vi.mocked(fetchBackupDestination).mockResolvedValue(S3_DESTINATION);
    vi.mocked(fetchBackups).mockResolvedValue([]);
    vi.mocked(fetchRemoteBackups).mockResolvedValue([
      {
        backupId: 'bkp_remote',
        key: 'backups/bkp_remote.tar',
        sizeBytes: 2048,
        lastModified: '2026-08-20T09:00:00.000Z',
        alreadyLocal: false,
      },
    ]);
    vi.mocked(importRemoteBackup).mockResolvedValue('job-import-1');
    const user = userEvent.setup();

    renderPage();

    await user.click(await screen.findByRole('button', { name: /Browse remote/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('bkp_remote')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(vi.mocked(importRemoteBackup)).toHaveBeenCalledWith('bkp_remote'));
  });

  it('does not offer Browse remote when no destination is configured', async () => {
    vi.mocked(fetchBackups).mockResolvedValue([makeBackup({ id: 'backup-1' })]);
    renderPage();
    await waitFor(() => expect(screen.getByText('backup-1')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Browse remote/ })).not.toBeInTheDocument();
  });
});
