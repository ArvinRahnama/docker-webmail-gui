/**
 * The in-process job runner (M10 — the milestone brief's "one in-process
 * runner executing one job at a time — deliberately serial, because two
 * concurrent restores, or a backup during a restore, is a data-corruption
 * scenario"). A job is any closure a caller (`modules/backups/*`,
 * eventually others) hands to {@link JobRunner.enqueue}; this file knows
 * nothing about backups, restore or DMS — it only knows how to run one
 * closure at a time, persist its status/progress/log through
 * `JobsRepository`, and broadcast every change to whoever is subscribed
 * (`modules/jobs/jobs.routes.ts`'s SSE endpoint, via
 * {@link JobRunner.subscribe}).
 *
 * **Serial by construction, not by convention.** `pump()` is the only
 * method that reads/writes `current`, and it always checks `current` is
 * `null` before starting the next job — there is no separate "is the
 * runner busy" flag that could drift from reality, and every enqueue path
 * (including a job that finishes and immediately triggers the next) goes
 * through this one method. `job-runner.test.ts` asserts this directly: two
 * jobs enqueued back to back never have overlapping `running` windows.
 *
 * **Startup recovery** (a job left `queued`/`running` by a previous
 * process) is `JobsRepository.recoverInterruptedJobs()`'s job, called once
 * by {@link createJobRunner} below. An in-process runner has no queue of
 * *closures* surviving a process restart — only the database rows do — so
 * there is nothing to resume; the honest behaviour is to fail those rows
 * with a clear reason, which is exactly what that repository method
 * already does (kept unchanged from the pre-existing implementation this
 * milestone builds on).
 */
import type { Job, JobLogLevel, JobStreamEvent, JobType, JsonValue } from '@dwg/shared';
import type { Logger } from 'pino';
import type { JobsRepository } from './jobs.repository.js';

export interface JobContext {
  readonly jobId: string;
  /** Appends one `job_logs` row and publishes it to any live SSE subscriber. */
  log(level: JobLogLevel, message: string): void;
  /** Updates the job's 0-100 progress and publishes the new snapshot. Never inferred from elapsed time — the caller reports real milestones (e.g. "volume 2 of 4 archived"). */
  setProgress(percent: number): void;
}

export interface EnqueueParams {
  readonly type: JobType;
  readonly createdByAdminId: string | null;
  readonly createdByLabel: string;
  /** Attached to the job row immediately, before execution starts (e.g. `{ mode: 'warm' }`) — visible to a client that lists jobs while this one is still queued. */
  readonly metadata: JsonValue;
  /**
   * The actual work. Runs with exactly one other job ever running
   * concurrently in this process: none. Its resolved value becomes the
   * job's *final* metadata (`JobsRepository.markSucceeded`) — a caller
   * that wants the initial parameters to survive into the result (e.g.
   * `mode` alongside a newly created `backupId`) must include them again
   * in what it returns; the two are not merged automatically.
   */
  readonly execute: (ctx: JobContext) => Promise<JsonValue>;
}

type Listener = (event: JobStreamEvent) => void;

/**
 * Thrown by {@link JobRunner.cancel} when the target job is not (or no
 * longer) queued. A *running* job cannot be interrupted mid-flight by this
 * runner — `JobContext` carries no cancellation token, deliberately: a
 * half-applied restore or half-written backup archive is worse than one
 * that finishes, so "cancel" only ever means "never start" here, and this
 * error is how that limit is reported rather than silently no-opped.
 */
export class JobNotCancellableError extends Error {
  constructor(jobId: string, status: string) {
    super(
      status === 'unknown'
        ? `Job ${jobId} does not exist.`
        : `Job ${jobId} cannot be cancelled: it is already ${status}, not queued.`,
    );
    this.name = 'JobNotCancellableError';
  }
}

export class JobRunner {
  private readonly queue: string[] = [];
  private readonly pending = new Map<string, EnqueueParams>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private current: string | null = null;

  constructor(
    private readonly repository: JobsRepository,
    private readonly logger: Logger,
  ) {}

  /** The id of the job currently executing, or `null` when idle. Exposed for tests asserting strict serial execution — no production call site needs this. */
  get currentJobId(): string | null {
    return this.current;
  }

  /** How many jobs are queued behind the one currently running (if any). */
  get queueLength(): number {
    return this.queue.length;
  }

  /** Persists a new `queued` job row and appends it to the run queue. Returns immediately — the caller gets the job back before `execute` ever runs, exactly like every other "enqueue" API in this codebase (ARCHITECTURE.md §7.5). */
  enqueue(params: EnqueueParams): Job {
    const job = this.repository.insert({
      type: params.type,
      createdByAdminId: params.createdByAdminId,
      createdByLabel: params.createdByLabel,
      metadata: params.metadata,
    });
    this.pending.set(job.id, params);
    this.queue.push(job.id);
    this.publish(job.id, { kind: 'snapshot', job });
    // Fire-and-forget: `pump` is self-driving (its own `finally` chains to
    // the next item), and `enqueue` itself must stay synchronous so
    // callers get a `Job` back immediately rather than a Promise.
    void this.pump();
    return job;
  }

  /** Cancels a job that has not started yet. See {@link JobNotCancellableError} for why a running job cannot be cancelled here. */
  cancel(jobId: string): Job {
    const job = this.repository.getById(jobId);
    if (job === null) {
      throw new JobNotCancellableError(jobId, 'unknown');
    }
    if (job.status !== 'queued') {
      throw new JobNotCancellableError(jobId, job.status);
    }

    const index = this.queue.indexOf(jobId);
    if (index !== -1) this.queue.splice(index, 1);
    this.pending.delete(jobId);

    const cancelled = this.repository.markCancelled(jobId);
    this.publish(jobId, { kind: 'snapshot', job: cancelled });
    return cancelled;
  }

  /** Subscribes to every event for one job (snapshots + log lines) until the returned function is called. Used by the SSE route — see `modules/jobs/jobs.routes.ts`. */
  subscribe(jobId: string, listener: Listener): () => void {
    let set = this.listeners.get(jobId);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(jobId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(jobId);
    };
  }

  private publish(jobId: string, event: JobStreamEvent): void {
    const set = this.listeners.get(jobId);
    if (set === undefined) return;
    for (const listener of set) listener(event);
  }

  private async pump(): Promise<void> {
    if (this.current !== null) return; // Something is already running — serial by construction.
    const nextId = this.queue.shift();
    if (nextId === undefined) return;
    const params = this.pending.get(nextId);
    this.pending.delete(nextId);
    if (params === undefined) return; // Cancelled between enqueue and pump.

    this.current = nextId;
    const running = this.repository.markRunning(nextId);
    this.publish(nextId, { kind: 'snapshot', job: running });

    const ctx: JobContext = {
      jobId: nextId,
      log: (level, message) => {
        const entry = this.repository.appendLog(nextId, level, message);
        this.publish(nextId, { kind: 'log', entry });
      },
      setProgress: (percent) => {
        const updated = this.repository.updateProgress(nextId, percent);
        this.publish(nextId, { kind: 'snapshot', job: updated });
      },
    };

    try {
      const result = await params.execute(ctx);
      const finished = this.repository.markSucceeded(nextId, result);
      this.publish(nextId, { kind: 'snapshot', job: finished });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error({ err, jobId: nextId }, 'Job failed');
      const failed = this.repository.markFailed(nextId, message);
      this.publish(nextId, { kind: 'snapshot', job: failed });
    } finally {
      this.current = null;
      void this.pump(); // Pick up whatever queued while this one ran.
    }
  }
}

/**
 * Builds a {@link JobRunner} and immediately runs startup recovery
 * (`JobsRepository.recoverInterruptedJobs`) — call once, at `buildApp`
 * time. There is no `onClose` hook to register: an in-flight `execute`
 * closure is an ordinary pending promise, and `index.ts`'s own shutdown
 * sequence already waits for in-flight Fastify requests before closing the
 * database, which is the only shared resource a job touches.
 */
export function createJobRunner(repository: JobsRepository, logger: Logger): JobRunner {
  const recovered = repository.recoverInterruptedJobs();
  if (recovered.length > 0) {
    logger.warn(
      { jobIds: recovered },
      `Marked ${recovered.length} job(s) failed: interrupted by a server restart before they could finish.`,
    );
  }
  return new JobRunner(repository, logger);
}
