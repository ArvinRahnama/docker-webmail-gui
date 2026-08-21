/**
 * SQL access for `jobs`/`job_logs` (migration 001, `created_by_label`
 * added by 004). Every status transition lives here as one named method
 * so `job-runner.ts` never hand-writes SQL — mirrors
 * `modules/auth/sessions.repository.ts`'s split from `AuthService`.
 */
import type { Database } from '../db.js';
import { generateId } from '../errors.js';
import type { Job, JobLogEntry, JobLogLevel, JobStatus, JobType } from '@dwg/shared';
import { JOB_ACTIVE_STATUSES } from '@dwg/shared';
import type { JsonValue } from '@dwg/shared';

interface JobRow {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly progress: number;
  readonly created_by_admin_id: string | null;
  readonly created_by_label: string;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly error_message: string | null;
  readonly metadata: string | null;
}

interface JobLogRow {
  readonly id: string;
  readonly job_id: string;
  readonly logged_at: string;
  readonly level: string;
  readonly message: string;
}

function parseMetadata(raw: string | null): JsonValue {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    return null;
  }
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    type: row.type as JobType,
    status: row.status as JobStatus,
    progress: row.progress,
    createdByAdminId: row.created_by_admin_id,
    createdByLabel: row.created_by_label,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    errorMessage: row.error_message,
    metadata: parseMetadata(row.metadata),
  };
}

function toJobLogEntry(row: JobLogRow): JobLogEntry {
  return {
    id: row.id,
    jobId: row.job_id,
    loggedAt: row.logged_at,
    level: row.level as JobLogLevel,
    message: row.message,
  };
}

export interface InsertJobParams {
  readonly type: JobType;
  readonly createdByAdminId: string | null;
  readonly createdByLabel: string;
  readonly metadata: JsonValue;
}

/** Most recent jobs shown in the tray/history — bounded so a long-lived install's history table never turns an ordinary list call into an unbounded scan. */
const DEFAULT_LIST_LIMIT = 50;

export class JobsRepository {
  constructor(private readonly db: Database) {}

  insert(params: InsertJobParams): Job {
    const id = generateId('job');
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO jobs
         (id, type, status, progress, created_by_admin_id, created_by_label, created_at, started_at, finished_at, error_message, metadata)
       VALUES (?, ?, 'queued', 0, ?, ?, ?, NULL, NULL, NULL, ?)`,
      [
        id,
        params.type,
        params.createdByAdminId,
        params.createdByLabel,
        now,
        JSON.stringify(params.metadata),
      ],
    );
    return this.getByIdOrThrow(id);
  }

  getById(id: string): Job | null {
    const row = this.db.get<JobRow>('SELECT * FROM jobs WHERE id = ?', [id]);
    return row ? toJob(row) : null;
  }

  private getByIdOrThrow(id: string): Job {
    const job = this.getById(id);
    if (!job)
      throw new Error(`JobsRepository: job ${id} was just inserted but cannot be read back`);
    return job;
  }

  list(limit: number = DEFAULT_LIST_LIMIT): readonly Job[] {
    const rows = this.db.all<JobRow>('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?', [
      limit,
    ]);
    return rows.map(toJob);
  }

  listLogs(jobId: string): readonly JobLogEntry[] {
    const rows = this.db.all<JobLogRow>(
      'SELECT * FROM job_logs WHERE job_id = ? ORDER BY logged_at ASC',
      [jobId],
    );
    return rows.map(toJobLogEntry);
  }

  markRunning(id: string): Job {
    this.db.run(`UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?`, [
      new Date().toISOString(),
      id,
    ]);
    return this.getByIdOrThrow(id);
  }

  updateProgress(id: string, progress: number): Job {
    const clamped = Math.max(0, Math.min(100, Math.round(progress)));
    this.db.run('UPDATE jobs SET progress = ? WHERE id = ?', [clamped, id]);
    return this.getByIdOrThrow(id);
  }

  markSucceeded(id: string, metadata: JsonValue): Job {
    this.db.run(
      `UPDATE jobs SET status = 'succeeded', progress = 100, finished_at = ?, metadata = ? WHERE id = ?`,
      [new Date().toISOString(), JSON.stringify(metadata), id],
    );
    return this.getByIdOrThrow(id);
  }

  markFailed(id: string, errorMessage: string): Job {
    this.db.run(
      `UPDATE jobs SET status = 'failed', finished_at = ?, error_message = ? WHERE id = ?`,
      [new Date().toISOString(), errorMessage, id],
    );
    return this.getByIdOrThrow(id);
  }

  markCancelled(id: string, errorMessage: string = 'Cancelled.'): Job {
    this.db.run(
      `UPDATE jobs SET status = 'cancelled', finished_at = ?, error_message = ? WHERE id = ?`,
      [new Date().toISOString(), errorMessage, id],
    );
    return this.getByIdOrThrow(id);
  }

  appendLog(jobId: string, level: JobLogLevel, message: string): JobLogEntry {
    const id = generateId('jlg');
    const loggedAt = new Date().toISOString();
    this.db.run(
      'INSERT INTO job_logs (id, job_id, logged_at, level, message) VALUES (?, ?, ?, ?, ?)',
      [id, jobId, loggedAt, level, message],
    );
    return { id, jobId, loggedAt, level, message };
  }

  /**
   * Startup recovery (ARCHITECTURE.md §7.5's "persisting state so progress
   * survives a page reload" is about the *browser* reloading while the
   * server process keeps running a job — it is not a promise that a job
   * resumes across a server restart, which this in-process runner cannot
   * do). Any job still `queued`/`running` from a previous process is
   * marked `failed` with an honest reason rather than left to look
   * eternally in-progress. Returns the ids fixed, for the caller to log.
   */
  recoverInterruptedJobs(): readonly string[] {
    const stale = this.db.all<JobRow>(
      `SELECT * FROM jobs WHERE status IN (${[...JOB_ACTIVE_STATUSES].map(() => '?').join(', ')})`,
      [...JOB_ACTIVE_STATUSES],
    );
    for (const row of stale) {
      this.markFailed(row.id, 'Interrupted by a server restart before this job could finish.');
    }
    return stale.map((row) => row.id);
  }
}
