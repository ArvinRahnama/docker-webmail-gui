/**
 * The generic jobs surface (list/detail/stream/cancel) — M10. Thin on
 * purpose: creating a job is always a *specific* module's job (e.g.
 * `modules/backups/backups.service.ts` calls `JobRunner.enqueue` directly
 * with its own `backup.create` closure), so this service never enqueues
 * anything itself. It only reads what `JobsRepository` already has and
 * forwards cancellation/subscription to the one shared `JobRunner`
 * instance — mirroring how `ContainersService` is a thin wrapper over
 * `BrokerClient` with no business logic of its own to test independently.
 */
import type { Job, JobDetailResponse, JobStreamEvent } from '@dwg/shared';
import { AppError } from '../../platform/errors.js';
import { JobNotCancellableError, type JobRunner } from '../../platform/jobs/job-runner.js';
import type { JobsRepository } from '../../platform/jobs/jobs.repository.js';

export class JobsService {
  constructor(
    private readonly repository: JobsRepository,
    private readonly runner: JobRunner,
  ) {}

  list(limit?: number): readonly Job[] {
    return this.repository.list(limit);
  }

  getDetail(jobId: string): JobDetailResponse {
    const job = this.repository.getById(jobId);
    if (job === null) {
      throw new AppError('NOT_FOUND', `No job with id ${jobId}.`);
    }
    return { job, logs: [...this.repository.listLogs(jobId)] };
  }

  cancel(jobId: string): Job {
    try {
      return this.runner.cancel(jobId);
    } catch (err) {
      if (err instanceof JobNotCancellableError) {
        throw new AppError('CONFLICT', err.message);
      }
      throw err;
    }
  }

  /** Subscribes to one job's live events (used by the SSE route). Returns an unsubscribe function. */
  subscribe(jobId: string, listener: (event: JobStreamEvent) => void): () => void {
    return this.runner.subscribe(jobId, listener);
  }
}
