import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BackupDestinationStatus, BackupSchedule } from '@dwg/shared';
import { BackupScheduleCard, RemoteDestinationCard } from './backup-remote-settings';
import {
  fetchBackupDestination,
  fetchBackupSchedule,
  revealBackupDestinationSecret,
  updateBackupDestination,
  updateBackupSchedule,
} from '@/lib/maintenance-api';

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
    await user.type(screen.getByLabelText('Region'), 'us-east-1');
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
