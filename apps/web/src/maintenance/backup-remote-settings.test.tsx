import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ZodError } from 'zod';
import type { BackupDestinationStatus, BackupSchedule } from '@dwg/shared';
import { BackupScheduleCard, RemoteDestinationCard } from './backup-remote-settings';
import { ApiError } from '@/lib/api-client';
import {
  fetchBackupDestination,
  fetchBackupSchedule,
  revealBackupDestinationSecret,
  updateBackupDestination,
  updateBackupSchedule,
} from '@/lib/maintenance-api';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/lib/maintenance-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/maintenance-api')>()),
  fetchBackupDestination: vi.fn(),
  updateBackupDestination: vi.fn(),
  testBackupDestination: vi.fn(),
  revealBackupDestinationSecret: vi.fn(),
  fetchBackupSchedule: vi.fn(),
  updateBackupSchedule: vi.fn(),
}));

const NONE_STATUS: BackupDestinationStatus = {
  type: 'none',
  configured: false,
  describe: null,
  s3: null,
  ftp: null,
};

const S3_STATUS: BackupDestinationStatus = {
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
  ftp: null,
};

const FTP_STATUS: BackupDestinationStatus = {
  type: 'ftp',
  configured: true,
  describe: 'ftp://ftp.example.com/backups',
  s3: null,
  ftp: {
    host: 'ftp.example.com',
    port: 21,
    path: 'backups',
    user: 'backup-user',
    secure: true,
    passwordSet: true,
  },
};

const SCHEDULE: BackupSchedule = {
  frequency: 'daily',
  enabled: true,
  mode: 'warm',
  retentionKeep: 3,
  retentionMaxAgeDays: null,
  uploadToRemote: true,
  lastRunAt: null,
  nextRunAt: '2026-09-03T12:00:00.000Z',
  updatedAt: '2026-09-02T12:00:00.000Z',
};

function renderCard(node: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RemoteDestinationCard', () => {
  it('configures an S3 destination from scratch and saves the entered fields', async () => {
    vi.mocked(fetchBackupDestination).mockResolvedValue(NONE_STATUS);
    vi.mocked(updateBackupDestination).mockResolvedValue(S3_STATUS);
    const user = userEvent.setup();
    renderCard(<RemoteDestinationCard />);

    await waitFor(() => expect(screen.getByText('Not configured')).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText('Destination'), 's3');
    await user.type(screen.getByLabelText('Endpoint'), 'https://s3.example.com');
    await user.type(screen.getByLabelText('Region (optional)'), 'us-east-1');
    await user.type(screen.getByLabelText('Bucket'), 'bucket');
    await user.type(screen.getByLabelText('Access key ID'), 'AKIAEXAMPLE');
    await user.type(screen.getByLabelText('Secret access key'), 'the-secret');
    await user.click(screen.getByRole('button', { name: 'Save destination' }));

    await waitFor(() => expect(vi.mocked(updateBackupDestination)).toHaveBeenCalled());
    expect(vi.mocked(updateBackupDestination).mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        type: 's3',
        endpoint: 'https://s3.example.com',
        region: 'us-east-1',
        bucket: 'bucket',
        accessKeyId: 'AKIAEXAMPLE',
        secretAccessKey: 'the-secret',
      }),
    );
  });

  it('refuses a region display name inline — no request, no generic toast — and clears the error on edit', async () => {
    vi.mocked(fetchBackupDestination).mockResolvedValue(NONE_STATUS);
    vi.mocked(updateBackupDestination).mockResolvedValue(S3_STATUS);
    const user = userEvent.setup();
    renderCard(<RemoteDestinationCard />);

    await waitFor(() => expect(screen.getByText('Not configured')).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText('Destination'), 's3');
    await user.type(screen.getByLabelText('Endpoint'), 'bucket.provider.example');
    await user.type(screen.getByLabelText('Region (optional)'), 'Tehran 3');
    await user.type(screen.getByLabelText('Bucket'), 'Company-Website');
    await user.type(screen.getByLabelText('Access key ID'), 'AKIAEXAMPLE');
    await user.type(screen.getByLabelText('Secret access key'), 'the-secret');
    await user.click(screen.getByRole('button', { name: 'Save destination' }));

    const region = screen.getByLabelText('Region (optional)');
    expect(region).toHaveAttribute('aria-invalid', 'true');
    expect(region.getAttribute('aria-describedby')).toContain('s3-region-error');
    expect(screen.getByRole('alert')).toHaveTextContent(/region code/);
    // The bare-host endpoint is not an error — https:// is added for it.
    expect(screen.getByLabelText('Endpoint')).not.toHaveAttribute('aria-invalid');
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      expect.stringMatching(/^Region: .*region code/),
    );
    expect(vi.mocked(toast.error)).not.toHaveBeenCalledWith('Could not save the destination');
    expect(vi.mocked(updateBackupDestination)).not.toHaveBeenCalled();

    await user.clear(region);
    expect(region).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // Blank region + bare host now save.
    await user.click(screen.getByRole('button', { name: 'Save destination' }));
    await waitFor(() => expect(vi.mocked(updateBackupDestination)).toHaveBeenCalled());
    expect(vi.mocked(updateBackupDestination).mock.calls[0]![0]).toMatchObject({
      endpoint: 'bucket.provider.example',
      region: '',
      bucket: 'Company-Website',
    });
  });

  it('shows per-field VALIDATION_FAILED details from the server under the matching inputs', async () => {
    vi.mocked(fetchBackupDestination).mockResolvedValue(S3_STATUS);
    vi.mocked(updateBackupDestination).mockRejectedValue(
      new ApiError(
        {
          code: 'VALIDATION_FAILED',
          message: 'The request body failed validation.',
          errorId: 'e_test',
          details: [{ path: 'bucket', message: 'Bucket name cannot contain spaces or slashes.' }],
        },
        400,
      ),
    );
    const user = userEvent.setup();
    renderCard(<RemoteDestinationCard />);

    await waitFor(() => expect(screen.getByText('Configured')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Save destination' }));

    await waitFor(() =>
      expect(screen.getByLabelText('Bucket')).toHaveAttribute('aria-invalid', 'true'),
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Bucket name cannot contain spaces or slashes.',
    );
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      'Bucket: Bucket name cannot contain spaces or slashes.',
    );

    await user.type(screen.getByLabelText('Bucket'), 'x');
    expect(screen.getByLabelText('Bucket')).not.toHaveAttribute('aria-invalid');
  });

  it('marks every missing field at once, secret included, when a new S3 destination is saved blank', async () => {
    vi.mocked(fetchBackupDestination).mockResolvedValue(NONE_STATUS);
    const user = userEvent.setup();
    renderCard(<RemoteDestinationCard />);

    await waitFor(() => expect(screen.getByText('Not configured')).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText('Destination'), 's3');
    await user.click(screen.getByRole('button', { name: 'Save destination' }));

    for (const label of ['Endpoint', 'Bucket', 'Access key ID', 'Secret access key']) {
      expect(screen.getByLabelText(label)).toHaveAttribute('aria-invalid', 'true');
    }
    // A blank region is fine — it defaults.
    expect(screen.getByLabelText('Region (optional)')).not.toHaveAttribute('aria-invalid');
    expect(screen.getByText('Enter the secret access key.')).toBeInTheDocument();
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      'Endpoint: Enter the endpoint, e.g. s3.example.com. (and 3 more)',
    );
    expect(vi.mocked(updateBackupDestination)).not.toHaveBeenCalled();
  });

  it('never renders the stored secret; reveals it only through the audited action', async () => {
    vi.mocked(fetchBackupDestination).mockResolvedValue(S3_STATUS);
    vi.mocked(revealBackupDestinationSecret).mockResolvedValue({ value: 'REVEALED-SECRET-XYZ' });
    const user = userEvent.setup();
    renderCard(<RemoteDestinationCard />);

    await waitFor(() => expect(screen.getByText('Configured')).toBeInTheDocument());

    // The secret input is empty (placeholder only) — the real secret is not in the DOM yet.
    const secretInput = screen.getByLabelText('Secret access key') as HTMLInputElement;
    expect(secretInput.value).toBe('');
    expect(screen.queryByText('REVEALED-SECRET-XYZ')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reveal stored secret' }));
    await waitFor(() => expect(screen.getByText('REVEALED-SECRET-XYZ')).toBeInTheDocument());
    expect(vi.mocked(revealBackupDestinationSecret)).toHaveBeenCalledTimes(1);
  });

  it('seeds the FTP fields from an ftp status, keeps the password masked, reveals on demand', async () => {
    vi.mocked(fetchBackupDestination).mockResolvedValue(FTP_STATUS);
    vi.mocked(revealBackupDestinationSecret).mockResolvedValue({ value: 'REVEALED-FTP-PW' });
    const user = userEvent.setup();
    renderCard(<RemoteDestinationCard />);

    await waitFor(() => expect(screen.getByText('Configured')).toBeInTheDocument());

    expect((screen.getByLabelText('Host') as HTMLInputElement).value).toBe('ftp.example.com');
    expect((screen.getByLabelText('Username') as HTMLInputElement).value).toBe('backup-user');
    const password = screen.getByLabelText('Password') as HTMLInputElement;
    expect(password.value).toBe('');
    expect(screen.queryByText('REVEALED-FTP-PW')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reveal stored password' }));
    await waitFor(() => expect(screen.getByText('REVEALED-FTP-PW')).toBeInTheDocument());
  });

  it('switching to FTP shows the FTP fields, and turning FTPS off warns about plaintext', async () => {
    vi.mocked(fetchBackupDestination).mockResolvedValue(NONE_STATUS);
    const user = userEvent.setup();
    renderCard(<RemoteDestinationCard />);

    await waitFor(() => expect(screen.getByText('Not configured')).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText('Destination'), 'ftp');
    expect(screen.getByLabelText('Host')).toBeInTheDocument();
    // FTPS defaults on -> no warning yet.
    expect(screen.queryByText(/Plaintext FTP/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: 'Use FTPS (explicit TLS)' }));
    expect(screen.getByText(/Plaintext FTP/)).toBeInTheDocument();
  });

  it('submitting an FTP edit with a blank password keeps the stored one (omits it)', async () => {
    vi.mocked(fetchBackupDestination).mockResolvedValue(FTP_STATUS);
    vi.mocked(updateBackupDestination).mockResolvedValue(FTP_STATUS);
    const user = userEvent.setup();
    renderCard(<RemoteDestinationCard />);

    await waitFor(() => expect(screen.getByText('Configured')).toBeInTheDocument());

    await user.clear(screen.getByLabelText('Host'));
    await user.type(screen.getByLabelText('Host'), 'ftp2.example.com');
    await user.click(screen.getByRole('button', { name: 'Save destination' }));

    await waitFor(() => expect(vi.mocked(updateBackupDestination)).toHaveBeenCalled());
    const arg = vi.mocked(updateBackupDestination).mock.calls[0]![0];
    expect(arg).toMatchObject({ type: 'ftp', host: 'ftp2.example.com', user: 'backup-user' });
    expect(arg).not.toHaveProperty('password');
  });

  it('configures FTP from scratch and saves the entered fields including the password', async () => {
    vi.mocked(fetchBackupDestination).mockResolvedValue(NONE_STATUS);
    vi.mocked(updateBackupDestination).mockResolvedValue(FTP_STATUS);
    const user = userEvent.setup();
    renderCard(<RemoteDestinationCard />);

    await waitFor(() => expect(screen.getByText('Not configured')).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText('Destination'), 'ftp');
    await user.type(screen.getByLabelText('Host'), 'ftp.example.com');
    await user.type(screen.getByLabelText('Username'), 'backup-user');
    await user.type(screen.getByLabelText('Path (optional)'), 'backups');
    await user.type(screen.getByLabelText('Password'), 'the-ftp-password');
    await user.click(screen.getByRole('button', { name: 'Save destination' }));

    await waitFor(() => expect(vi.mocked(updateBackupDestination)).toHaveBeenCalled());
    expect(vi.mocked(updateBackupDestination).mock.calls[0]![0]).toMatchObject({
      type: 'ftp',
      host: 'ftp.example.com',
      user: 'backup-user',
      path: 'backups',
      secure: true,
      password: 'the-ftp-password',
    });
  });

  it('clears a typed secret when the destination type changes, so it is never saved as the other type’s credential', async () => {
    vi.mocked(fetchBackupDestination).mockResolvedValue(NONE_STATUS);
    vi.mocked(updateBackupDestination).mockResolvedValue(FTP_STATUS);
    const user = userEvent.setup();
    renderCard(<RemoteDestinationCard />);

    await waitFor(() => expect(screen.getByText('Not configured')).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText('Destination'), 's3');
    await user.type(screen.getByLabelText('Secret access key'), 'the-s3-secret');
    await user.selectOptions(screen.getByLabelText('Destination'), 'ftp');

    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
    await user.type(screen.getByLabelText('Host'), 'ftp.example.com');
    await user.type(screen.getByLabelText('Username'), 'backup-user');
    await user.click(screen.getByRole('button', { name: 'Save destination' }));

    // Nothing is stored for FTP, so the blank password is refused inline.
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Enter the password.')).toBeInTheDocument();
    expect(vi.mocked(updateBackupDestination)).not.toHaveBeenCalled();

    // Switching back does not resurrect the S3 secret either.
    await user.selectOptions(screen.getByLabelText('Destination'), 's3');
    expect((screen.getByLabelText('Secret access key') as HTMLInputElement).value).toBe('');
  });

  it('shows a ZodError from the API wrapper’s own parse inline, like server validation details', async () => {
    vi.mocked(fetchBackupDestination).mockResolvedValue(S3_STATUS);
    vi.mocked(updateBackupDestination).mockRejectedValue(
      new ZodError([
        { code: 'custom', path: ['bucket'], message: 'Bucket rejected by the schema.', input: '' },
      ]),
    );
    const user = userEvent.setup();
    renderCard(<RemoteDestinationCard />);

    await waitFor(() => expect(screen.getByText('Configured')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Save destination' }));

    await waitFor(() =>
      expect(screen.getByLabelText('Bucket')).toHaveAttribute('aria-invalid', 'true'),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Bucket rejected by the schema.');
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Bucket: Bucket rejected by the schema.');
    expect(vi.mocked(toast.error)).not.toHaveBeenCalledWith('Could not save the destination');
  });
});

describe('BackupScheduleCard', () => {
  it('shows the next run and saves a changed frequency', async () => {
    vi.mocked(fetchBackupSchedule).mockResolvedValue(SCHEDULE);
    vi.mocked(updateBackupSchedule).mockResolvedValue({ ...SCHEDULE, frequency: 'weekly' });
    const user = userEvent.setup();
    renderCard(<BackupScheduleCard />);

    await waitFor(() => expect(screen.getByText(/Next run/)).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText('Frequency'), 'weekly');
    await user.click(screen.getByRole('button', { name: 'Save schedule' }));

    await waitFor(() => expect(vi.mocked(updateBackupSchedule)).toHaveBeenCalled());
    expect(vi.mocked(updateBackupSchedule).mock.calls[0]![0]).toEqual(
      expect.objectContaining({ frequency: 'weekly' }),
    );
  });
});
