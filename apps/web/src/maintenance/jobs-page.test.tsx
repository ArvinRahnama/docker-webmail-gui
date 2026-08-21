import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Job, JobStatus } from '@dwg/shared';
import { JobsPage } from './jobs-page';
import { cancelJob, fetchJobs } from '@/lib/maintenance-api';

// `use-maintenance-queries` imports the whole maintenance API surface, so
// the original module is spread back in and only the two functions this
// page actually reaches are replaced — a bare factory would leave every
// other named import undefined at module-eval time.
vi.mock('@/lib/maintenance-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/maintenance-api')>()),
  fetchJobs: vi.fn(),
  cancelJob: vi.fn(),
}));

function makeJob(
  overrides: Partial<Job> & { readonly id: string; readonly status: JobStatus },
): Job {
  return {
    type: 'backup.create',
    progress: 0,
    createdByAdminId: 'admin-1',
    createdByLabel: 'admin@example.com',
    createdAt: '2026-08-18T09:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    errorMessage: null,
    metadata: null,
    ...overrides,
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <JobsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('JobsPage — list states (UX_ARCHITECTURE.md §9)', () => {
  it('shows the table loading state while the job list is in flight', () => {
    vi.mocked(fetchJobs).mockReturnValue(new Promise(() => {}));

    renderPage();

    expect(screen.getByRole('status', { name: 'Loading table data' })).toBeInTheDocument();
  });

  it('shows the first-run empty state when no job has ever run', async () => {
    vi.mocked(fetchJobs).mockResolvedValue([]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('No jobs yet')).toBeInTheDocument();
    });
  });

  it('shows an error state with a retry action when the list cannot be loaded', async () => {
    vi.mocked(fetchJobs).mockRejectedValue(new Error('network down'));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Could not load the job list.')).toBeInTheDocument();
    });
    // §2 principle 8 — the error names a next action rather than dead-ending.
    expect(screen.getByRole('button', { name: /retry|try again/i })).toBeInTheDocument();
  });
});

describe('JobsPage — cancel is offered only for active statuses', () => {
  it('offers Cancel job for queued and running jobs and for no other status', async () => {
    vi.mocked(fetchJobs).mockResolvedValue([
      makeJob({ id: 'job-queued', status: 'queued' }),
      makeJob({ id: 'job-running', status: 'running', progress: 40 }),
      makeJob({ id: 'job-succeeded', status: 'succeeded', progress: 100 }),
      makeJob({ id: 'job-failed', status: 'failed', errorMessage: 'Archive checksum mismatch' }),
      makeJob({ id: 'job-cancelled', status: 'cancelled' }),
    ]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('job-queued')).toBeInTheDocument();
    });
    // Exactly the two `JOB_ACTIVE_STATUSES` rows, never the three terminal ones.
    expect(screen.getAllByRole('button', { name: 'Cancel job' })).toHaveLength(2);
  });

  it('confirms through a tier 1 dialog before cancelling, and cancels the job that was chosen', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchJobs).mockResolvedValue([
      makeJob({ id: 'job-running', status: 'running', progress: 40 }),
    ]);
    vi.mocked(cancelJob).mockResolvedValue({
      job: makeJob({ id: 'job-running', status: 'cancelled', progress: 40 }),
      logs: [],
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('job-running')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Cancel job' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Cancel this job?')).toBeInTheDocument();
    // §8: the destructive button is never the default-focused control.
    expect(within(dialog).getByRole('button', { name: 'Cancel job' })).not.toHaveFocus();

    await user.click(within(dialog).getByRole('button', { name: 'Cancel job' }));

    await waitFor(() => {
      expect(vi.mocked(cancelJob)).toHaveBeenCalledWith('job-running');
    });
  });
});

describe('JobsPage — job data is shown as reported, never inferred', () => {
  it('shows a failed job’s errorMessage on the list itself', async () => {
    vi.mocked(fetchJobs).mockResolvedValue([
      makeJob({
        id: 'job-failed',
        status: 'failed',
        progress: 62,
        startedAt: '2026-08-18T09:01:00.000Z',
        finishedAt: '2026-08-18T09:04:00.000Z',
        errorMessage: 'Archive checksum mismatch',
      }),
    ]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Archive checksum mismatch')).toBeInTheDocument();
    });
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('renders the reported progress number, and never invents progress for a running job at 0', async () => {
    vi.mocked(fetchJobs).mockResolvedValue([
      makeJob({ id: 'job-measured', status: 'running', type: 'backup.verify', progress: 45 }),
      makeJob({ id: 'job-unmeasured', status: 'running', type: 'backup.restore', progress: 0 }),
      makeJob({ id: 'job-queued', status: 'queued' }),
    ]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('job-measured')).toBeInTheDocument();
    });

    const measured = screen.getByRole('progressbar', { name: 'Verify backup progress' });
    expect(measured).toHaveAttribute('aria-valuenow', '45');
    expect(screen.getByText('45%')).toBeInTheDocument();

    // A running job the runner has not scored is stated as such — not
    // dressed up as movement it never reported.
    const unmeasured = screen.getByRole('progressbar', { name: 'Restore backup progress' });
    expect(unmeasured).toHaveAttribute('aria-valuenow', '0');
    expect(screen.getByText('No measured progress yet')).toBeInTheDocument();
    expect(screen.getByText('Not started')).toBeInTheDocument();
  });

  it('shows who started the job and its lifecycle timestamps', async () => {
    vi.mocked(fetchJobs).mockResolvedValue([
      makeJob({
        id: 'job-done',
        status: 'succeeded',
        progress: 100,
        createdByLabel: 'ops@example.com',
        startedAt: '2026-08-18T09:01:00.000Z',
        finishedAt: '2026-08-18T09:04:00.000Z',
      }),
    ]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('ops@example.com')).toBeInTheDocument();
    });
    expect(screen.getByText('Create backup')).toBeInTheDocument();
    expect(screen.getByText('Succeeded')).toBeInTheDocument();
    // Never "Unknown" for a finished job — all three stamps are real.
    expect(screen.queryByText('Unknown')).not.toBeInTheDocument();
  });
});
